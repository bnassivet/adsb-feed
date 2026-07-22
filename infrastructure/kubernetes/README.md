# Spark Standalone Cluster on Kubernetes

Deploys a self-contained Spark standalone cluster plus an S3-compatible object
store, suitable for local development and testing of the `spark-adsb` analytics
layer.

Two deployment options are provided for the **same** cluster spec — use one, not
both, on a given cluster (they share static resource names and would collide):

- **[Kustomize](https://kustomize.io/)** (default docs below) — one shared spec in
  `base/`, with per-version overlays that pin only the Spark image tag. Built into
  `kubectl`, no extra install.
- **[Helm](#deploy-with-helm-alternative)** — the `helm/adsb-spark` chart, with
  `values-4.1.1.yaml` / `values-4.2.0.yaml` presets mirroring the overlays. See
  the Helm section.

## Which overlay?

The cluster spec lives once in `base/`; pick an overlay by workload:

| Overlay | Spark | Use for |
|---------|-------|---------|
| `overlays/4.1.1` | 4.1.1 | **The real spark-adsb pipeline** (Delta + Pulsar jobs). Delta Lake caps at `pyspark<=4.1.1` and the Pulsar-Spark connector's newest build is `4.1.1.0`, so 4.2 is not yet an option for these jobs. |
| `overlays/4.2.0` | 4.2.0 | Pure-Spark / PySpark experimentation only — no Delta or Pulsar dependency. |

```
base/                     # the full spec (Deployments, Services, PVC), version-agnostic
  k8_manifest.yaml
  kustomization.yaml
overlays/
  4.1.1/kustomization.yaml   # images: newTag 4.1.1
  4.2.0/kustomization.yaml   # images: newTag 4.2.0
```

Every `kubectl` command below takes `-k overlays/<version>`; substitute the
overlay you want. Kustomize is built into `kubectl` (≥1.14) — no extra install.
Never `kubectl apply -f base/k8_manifest.yaml` directly; the image tag is a
placeholder that only the overlays resolve.

## Overview

| Component | Kind | Replicas | Purpose |
|-----------|------|----------|---------|
| `spark-master` | Deployment | 1 | Spark standalone master (RPC 7077, UI 8080, REST 6066) |
| `spark-worker` | Deployment | 2 | Spark workers, auto-register to the master |
| `spark-master` | Service | — | ClusterIP exposing master RPC 7077 + UI 8080 |
| `rustfs` | Deployment | 1 | RustFS S3-compatible object store (API 9000, console 9001) |
| `rustfs-data` | PersistentVolumeClaim | — | 4Gi persistent backing store for RustFS |
| `rustfs` | Service | — | ClusterIP exposing S3 API 9000 + console 9001 |

The master and worker daemons run in the **foreground** via `spark-class`, so the
cluster forms automatically on `kubectl apply` — workers discover the master over
the `spark-master` Service DNS. RustFS is S3-compatible and reachable from Spark
jobs at `http://rustfs:9000` (see the project root `CLAUDE.md` for how this fits
the edge-to-cloud medallion architecture).

## Prerequisites

- `kubectl`
- A local Kubernetes cluster: [kind](https://kind.sigs.k8s.io/) or
  [minikube](https://minikube.sigs.k8s.io/) (both ship a default StorageClass so
  the PVC binds dynamically)
- Optional: `aws` CLI to exercise the RustFS S3 endpoint

## Start a local cluster

```bash
# Option A: kind
kind create cluster --name adsb

# Option B: minikube
minikube start --cpus=4 --memory=8192
```

## Deploy

```bash
cd adsb-feed/infrastructure/kubernetes

# Preview the rendered manifests (optional)
kubectl kustomize overlays/4.1.1

# Validate against the live API first
kubectl apply -k overlays/4.1.1 --dry-run=server

# Apply for real (use overlays/4.2.0 for the experimentation variant)
kubectl apply -k overlays/4.1.1
```

## Deploy with Helm (alternative)

The `helm/adsb-spark` chart renders the identical cluster from a Helm chart. The
Spark-version split is driven by two preset values files (mirroring the overlays);
everything else is parameterized in `values.yaml`.

```bash
cd adsb-feed/infrastructure/kubernetes

# Preview / validate (optional)
helm template adsb-spark helm/adsb-spark -f helm/adsb-spark/values-4.1.1.yaml
helm install adsb-spark helm/adsb-spark -f helm/adsb-spark/values-4.1.1.yaml --dry-run=server

# Install — pipeline (Spark 4.1.1)
helm install adsb-spark helm/adsb-spark -f helm/adsb-spark/values-4.1.1.yaml

# ...or experimentation only (Spark 4.2.0)
helm install adsb-spark helm/adsb-spark -f helm/adsb-spark/values-4.2.0.yaml

# Smoke test (SparkPi via the driver DNS) — passes only if the job completes
helm test adsb-spark

# Change worker count (or any value) without editing files
helm upgrade adsb-spark helm/adsb-spark -f helm/adsb-spark/values-4.1.1.yaml \
  --set spark.worker.replicas=3

# Remove everything
helm uninstall adsb-spark
```

Notes:
- Requires the Helm CLI (`brew install helm`); Kustomize needs nothing beyond `kubectl`.
- Resource names are static (not release-prefixed) so the DNS references
  (`spark://spark-master:7077`, the headless driver name, `http://rustfs:9000`)
  stay valid — so only **one** release per namespace, and don't run it alongside
  the Kustomize deploy.
- The verify / submit / RustFS / scale sections below apply to either deployment
  method (same resource names). `helm test` is the Helm-native equivalent of the
  manual SparkPi submit.

## Verify the Spark cluster formed

```bash
# All pods Running: 1 spark-master, 2 spark-worker, 1 rustfs
kubectl get pods

# Master accepted the workers (one "Registering worker" line per worker)
kubectl logs deploy/spark-master | grep -E "Starting Spark master|Registering worker"

# Workers registered with the master
kubectl logs deploy/spark-worker | grep "Successfully registered with master"

# Master web UI — should list 2 ALIVE workers
kubectl port-forward svc/spark-master 8080:8080
# open http://localhost:8080
```

## Submit a test job

```bash
POD=$(kubectl get pod -l app=spark-master -o jsonpath='{.items[0].metadata.name}')
kubectl exec -it "$POD" -- /opt/spark/bin/spark-submit \
  --master spark://spark-master:7077 \
  --conf spark.driver.host=$(kubectl get pod "$POD" -o jsonpath='{.status.podIP}') \
  --class org.apache.spark.examples.SparkPi \
  /opt/spark/examples/jars/spark-examples_2.13-4.1.1.jar 100   # jar version = deployed Spark tag (4.2.0 on that overlay)
# Expect: "Pi is roughly 3.14..."
#
# spark.driver.host is REQUIRED: without it the driver advertises its pod
# HOSTNAME (e.g. spark-master-xxxx), which cluster DNS can't resolve, so every
# executor fails with UnknownHostException, exits code 1, and the scheduler
# loops forever adding/removing executors. Pinning it to the pod IP (routable
# on the pod network) lets executors connect back to the driver.
```

### Preferred: submit from the dedicated driver pod (stable DNS)

The `spark-driver` Deployment + headless Service give the driver a stable name
(`spark-driver.spark-driver.<ns>.svc.cluster.local`) that survives pod restarts,
so you never pin an ephemeral pod IP. Submit in **client mode** from that pod:

```bash
DRV=$(kubectl get pod -l app=spark-driver -o jsonpath='{.items[0].metadata.name}')
kubectl exec -it "$DRV" -- /opt/spark/bin/spark-submit \
  --master spark://spark-master:7077 \
  --deploy-mode client \
  --conf spark.driver.host=spark-driver.spark-driver.default.svc.cluster.local \
  --conf spark.driver.bindAddress=0.0.0.0 \
  --conf spark.driver.port=35000 \
  --conf spark.blockManager.port=35001 \
  --class org.apache.spark.examples.SparkPi \
  /opt/spark/examples/jars/spark-examples_2.13-4.1.1.jar 100   # jar version = deployed Spark tag (4.2.0 on that overlay)
# Expect: "Pi is roughly 3.14..."
#
# - spark.driver.host   → the headless Service DNS name (stable across restarts)
# - spark.driver.bindAddress=0.0.0.0 → bind all interfaces; the ADVERTISED
#   address (driver.host) differs from the BIND address inside the pod
# - driver.port / blockManager.port → match the headless Service's named ports
# Replace `default` with your namespace if not deploying to the default namespace.
```

### Submit a PySpark (Python) job

The same driver pod runs Python jobs — `spark-submit` takes a `.py` script
instead of a `--class` + JAR. The `apache/spark:4.2.0` image bundles PySpark and
Python 3.10, and ships example scripts under
`/opt/spark/examples/src/main/python/`.

```bash
DRV=$(kubectl get pod -l app=spark-driver -o jsonpath='{.items[0].metadata.name}')
kubectl exec -it "$DRV" -- /opt/spark/bin/spark-submit \
  --master spark://spark-master:7077 \
  --deploy-mode client \
  --conf spark.driver.host=spark-driver.spark-driver.default.svc.cluster.local \
  --conf spark.driver.bindAddress=0.0.0.0 \
  --conf spark.driver.port=35000 \
  --conf spark.blockManager.port=35001 \
  /opt/spark/examples/src/main/python/pi.py 100
# Expect: "Pi is roughly 3.14..."
```

**Run your own script:** copy it into the driver pod, then submit it.

```bash
DRV=$(kubectl get pod -l app=spark-driver -o jsonpath='{.items[0].metadata.name}')

# 1. Write a tiny PySpark job locally
cat > /tmp/wordcount.py <<'EOF'
from pyspark.sql import SparkSession

spark = SparkSession.builder.appName("wordcount").getOrCreate()
df = spark.createDataFrame(
    [("aircraft",), ("adsb",), ("aircraft",), ("spark",), ("adsb",), ("aircraft",)],
    ["word"],
)
df.groupBy("word").count().orderBy("count", ascending=False).show()
spark.stop()
EOF

# 2. Copy it into the driver pod
kubectl cp /tmp/wordcount.py "$DRV":/tmp/wordcount.py

# 3. Submit it (same driver-networking conf as above)
kubectl exec -it "$DRV" -- /opt/spark/bin/spark-submit \
  --master spark://spark-master:7077 \
  --deploy-mode client \
  --conf spark.driver.host=spark-driver.spark-driver.default.svc.cluster.local \
  --conf spark.driver.bindAddress=0.0.0.0 \
  --conf spark.driver.port=35000 \
  --conf spark.blockManager.port=35001 \
  /tmp/wordcount.py
# Expect a small word-count table.
#
# Extra Python deps? Bake them into a custom image (recommended), or pass
# --py-files for pure-Python modules. To read/write RustFS from PySpark, add the
# hadoop-aws S3A configs (spark.hadoop.fs.s3a.*) pointing at the rustfs Service.
```

## Test RustFS (S3 storage)

```bash
kubectl port-forward svc/rustfs 9000:9000 &

export AWS_ACCESS_KEY_ID=rustfs
export AWS_SECRET_ACCESS_KEY=rustfs123

aws --endpoint-url http://localhost:9000 s3 mb s3://adsb
aws --endpoint-url http://localhost:9000 s3 ls

# Persistence check: delete the pod, wait for the replacement, re-list.
# The bucket must survive because data lives on the rustfs-data PVC.
kubectl delete pod -l app=rustfs
kubectl rollout status deploy/rustfs
aws --endpoint-url http://localhost:9000 s3 ls
```

## Scale workers

```bash
kubectl scale deploy/spark-worker --replicas=3
# The new worker auto-registers — watch the master log or UI.
kubectl logs deploy/spark-master | grep "Registering worker"
```

## Tear down

```bash
kubectl delete -k overlays/4.1.1   # or overlays/4.2.0, whichever you applied

# Then remove the local cluster
kind delete cluster --name adsb   # or: minikube delete
```

## Notes

- Credentials (`rustfs` / `rustfs123`) and the 4Gi PVC size are demo-grade — set
  real secrets and sizing before any non-local use.
- Worker cores/memory are set via `SPARK_WORKER_CORES` / `SPARK_WORKER_MEMORY` in
  the `spark-worker` Deployment. Executor/driver memory are passed at
  `spark-submit` time, not on the daemons.
