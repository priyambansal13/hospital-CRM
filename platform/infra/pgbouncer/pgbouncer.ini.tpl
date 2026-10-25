;; PgBouncer for MediCare (docs/MULTI-TENANCY.md §3.2). One wildcard entry routes every database name (mc_control,
;; t_<hospital>) to the Postgres server; services keep small per-hospital pools and PgBouncer multiplexes them.
;; Transaction pooling: services must not rely on session state (search_path is set on each ROLE instead), and
;; migrations connect to Postgres directly (they use session-level advisory locks).
[databases]
* = host=${PG_SERVER_HOST} port=${PG_SERVER_PORT}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = 10
max_client_conn = 2000
max_db_connections = 40
server_idle_timeout = 60
ignore_startup_parameters = extra_float_digits
application_name_add_host = 1
admin_users = pgbouncer_admin
