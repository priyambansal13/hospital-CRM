{{- define "svc.image" -}}{{ printf "%s/%s:%s" .Values.image.registry .Values.name .Values.image.tag | trimPrefix "/" }}{{- end -}}
{{- define "svc.labels" -}}
app.kubernetes.io/name: {{ .Values.name }}
app.kubernetes.io/part-of: medicare
app.kubernetes.io/component: backend
{{- end -}}
{{- define "svc.env" -}}
- name: SERVICE_NAME
  value: {{ .Values.name | quote }}
- name: PORT
  value: {{ .Values.port | quote }}
- name: INTERNAL_API_TOKEN
  valueFrom: { secretKeyRef: { name: {{ .Values.secret }}, key: INTERNAL_API_TOKEN } }
- name: REDIS_URL
  valueFrom: { secretKeyRef: { name: {{ .Values.secret }}, key: REDIS_URL } }
{{- if .Values.schema }}
- name: DB_PASSWORD_SVC_{{ upper .Values.schema }}
  valueFrom: { secretKeyRef: { name: {{ .Values.secret }}, key: DB_PASSWORD_SVC_{{ upper .Values.schema }} } }
{{- end }}
{{- range .Values.extraSecretKeys }}
- name: {{ . }}
  valueFrom: { secretKeyRef: { name: {{ $.Values.secret }}, key: {{ . }} } }
{{- end }}
{{- end -}}
{{- define "svc.securityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
runAsUser: 1000
capabilities: { drop: ["ALL"] }
{{- end -}}
