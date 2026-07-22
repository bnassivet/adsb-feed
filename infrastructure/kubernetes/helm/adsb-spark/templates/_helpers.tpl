{{/*
Component names — DNS-critical, sourced from .Values.names so the master
Service name, worker --master arg, headless driver DNS, and RustFS endpoint all
stay consistent. Intentionally NOT release-name-prefixed.
*/}}
{{- define "adsb-spark.masterName" -}}{{ .Values.names.master }}{{- end -}}
{{- define "adsb-spark.workerName" -}}{{ .Values.names.worker }}{{- end -}}
{{- define "adsb-spark.driverName" -}}{{ .Values.names.driver }}{{- end -}}
{{- define "adsb-spark.rustfsName" -}}{{ .Values.names.rustfs }}{{- end -}}

{{/*
Chart/version metadata labels applied to every object. NOTE: the pod-selecting
label is `app: <name>` (set per-workload, not here) to match the existing
Kustomize selectors — do not switch to app.kubernetes.io/name.
*/}}
{{- define "adsb-spark.commonLabels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: adsb-spark
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
The Spark image reference, shared by master/worker/driver.
*/}}
{{- define "adsb-spark.sparkImage" -}}
{{ .Values.spark.image.repository }}:{{ .Values.spark.image.tag }}
{{- end -}}
