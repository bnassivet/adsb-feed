# Spark 4.1 Standalone Cluster on Kubernetes

`k8_manifest.yaml` deploys a self-contained Spark standalone cluster plus an
S3-compatible object store, suitable for local development and testing of the
`spark-adsb` analytics layer.

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

# Validate against the live API first
kubectl apply --dry-run=server -f k8_manifest.yaml

# Apply for real
kubectl apply -f k8_manifest.yaml
```

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
  --class org.apache.spark.examples.SparkPi \
  /opt/spark/examples/jars/spark-examples_2.13-4.1.1.jar 100
# Expect: "Pi is roughly 3.14..."
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
kubectl delete -f k8_manifest.yaml

# Then remove the local cluster
kind delete cluster --name adsb   # or: minikube delete
```

## Notes

- Credentials (`rustfs` / `rustfs123`) and the 4Gi PVC size are demo-grade — set
  real secrets and sizing before any non-local use.
- Worker cores/memory are set via `SPARK_WORKER_CORES` / `SPARK_WORKER_MEMORY` in
  the `spark-worker` Deployment. Executor/driver memory are passed at
  `spark-submit` time, not on the daemons.
