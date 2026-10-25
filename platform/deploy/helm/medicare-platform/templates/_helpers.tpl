{{- define "plat.secretKeys" -}}
{{- $keys := list "INTERNAL_API_TOKEN" "REDIS_URL" "SESSION_SECRET" "MC_IAM_CLIENT_SECRET" "SMTP_USER" "SMTP_PASSWORD" "PG_ADMIN_PASSWORD" "PGBOUNCER_USERLIST" "RAZORPAY_KEY_ID" "RAZORPAY_KEY_SECRET" "RAZORPAY_WEBHOOK_SECRET" "MC_MASTER_KEY" "S3_ACCESS_KEY" "S3_SECRET_KEY" -}}
{{- range .Values.services }}{{- if or .control .tenant }}{{- $keys = append $keys (printf "DB_PASSWORD_SVC_%s" (upper .schema)) -}}{{- end }}{{- end -}}
{{- toJson $keys -}}
{{- end -}}
