job "publish-anyone-client-npm" {
  datacenters = [ "ator-fin" ]
  type = "batch"
  namespace = "operations"

  constraint {
    attribute = "${meta.pool}"
    value = "operations"
  }

  group "publish-anyone-client-npm-group" {
    count = 1

    task "publish-anyone-client-npm-task" {
      driver = "docker"

      config {
        image = "ghcr.io/anyone-protocol/anyone-client:[[ .version ]]"
        mount {
          type = "bind"
          source = "local/entrypoint.sh"
          target = "/usr/src/app/entrypoint.sh"
          readonly = true
        }
        logging {
          type = "loki"
          config {
            loki-url = "${LOKI_URL}"
            loki-external-labels = "container_name={{.Name}},job_name=${NOMAD_JOB_NAME}"
          }
        }
      }

      template {
        data = <<-EOF
        #!/bin/sh
        if echo "$VERSION" | grep -q "beta"; then
          npm publish --tag beta
        else
          npm publish
        fi
        EOF
        destination = "local/entrypoint.sh"
        perms = "0555"
      }

      vault { role = "any1-nomad-workloads-controller" }

      identity {
        name = "vault_default"
        aud  = [ "any1-infra" ]
        ttl  = "1h"
      }

      template {
        data = <<-EOH
        {{ with secret "kv/operations/publish-anyone-client-npm" }}
        NODE_AUTH_TOKEN="{{ .Data.data.NPM_TOKEN }}"
        {{ end }}
        EOH
        destination = "secrets/.env"
      }

      template {
        data = <<-EOH
        {{ range service "loki" }}
        LOKI_URL="http://{{ .Address }}:{{ .Port }}/loki/api/v1/push"
        {{ end }}
        EOH
        destination = "local/config.env"
        env         = true
      }

      resources {
        cpu    = 512
        memory = 512
      }
    }
  }
}
