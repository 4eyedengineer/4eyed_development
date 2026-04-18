# Kubernetes Job Template for Kaniko Docker Image Builds
#
# Handles two modes:
#   1. Repo Dockerfile: dockerfilePath points to a file in the cloned repo
#   2. Generated Dockerfile: dockerfileConfigMap is set; an init container copies
#      files from the ConfigMap into /workspace, and dockerfilePath should be
#      /workspace/Dockerfile (or similar).
#
# Template Variables:
#   namespace           - Kubernetes namespace for the job
#   jobName             - Unique job name (should include timestamp or commit SHA)
#   repoUrl             - GitHub repository URL (e.g., github.com/owner/repo)
#   branch              - Git branch to build from
#   commitSha           - Specific commit SHA to build
#   dockerfilePath      - Path to Dockerfile (relative to /workspace, or absolute)
#   imageDest           - Full destination image path (e.g., harbor.example.com/project/image:tag)
#   gitSecretName       - Name of Kubernetes secret containing git credentials
#   registrySecretName  - Name of Kubernetes secret containing registry credentials
#   dockerfileConfigMap - (optional) Name of ConfigMap with generated Dockerfile + extra files
#
# Secrets Required:
#   Git Secret (gitSecretName):
#     - GIT_USERNAME: GitHub username or token name
#     - GIT_PASSWORD: GitHub personal access token
#
#   Registry Secret (registrySecretName):
#     - config.json: Docker registry config for Harbor authentication
#
# ConfigMap (when dockerfileConfigMap is set):
#   - Dockerfile: The generated Dockerfile content
#   - .dockerignore: (optional) The generated .dockerignore content
#   - Other files with escaped paths (src_nginx.conf -> src/nginx.conf)
#
# Resource Defaults:
#   Memory: 2Gi (request), 4Gi (limit)
#   CPU: 500m (request), 2000m (limit)
#
# Job Cleanup:
#   TTL: 3600 seconds (1 hour) after completion

apiVersion: batch/v1
kind: Job
metadata:
  name: {{jobName}}
  namespace: {{namespace}}
  labels:
    app: kaniko-build
    managed-by: dangus-cloud
    commit-sha: {{commitSha}}
{{#dockerfileConfigMap}}
    dockerfile-source: generated
{{/dockerfileConfigMap}}
spec:
  ttlSecondsAfterFinished: 3600
  backoffLimit: 2
  activeDeadlineSeconds: 1800
  template:
    metadata:
      labels:
        app: kaniko-build
        job-name: {{jobName}}
    spec:
      restartPolicy: Never
      initContainers:
        - name: git-clone
          image: alpine/git:latest
          env:
            - name: GIT_USERNAME
              valueFrom:
                secretKeyRef:
                  name: {{gitSecretName}}
                  key: GIT_USERNAME
            - name: GIT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{gitSecretName}}
                  key: GIT_PASSWORD
          command:
            - /bin/sh
            - -c
            - |
              git clone --single-branch --branch {{branch}} \
                https://${GIT_USERNAME}:${GIT_PASSWORD}@{{repoUrl}} /workspace && \
              cd /workspace && \
              git checkout {{commitSha}}
          volumeMounts:
            - name: workspace
              mountPath: /workspace
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
{{#dockerfileConfigMap}}
        # Copy generated/modified files into the workspace.
        # Supports multi-file ConfigMaps where paths are escaped (src/nginx.conf -> src_nginx.conf).
        - name: copy-dockerfile
          image: busybox:1.36
          command:
            - /bin/sh
            - -c
            - |
              echo "=== Copying files from ConfigMap ==="
              for file in /generated/*; do
                if [ -f "$file" ]; then
                  filename=$(basename "$file")
                  # Decode path: convert single underscores to slashes, then double to single
                  # e.g., src_my__config.js -> src/my_config.js
                  # Uses null byte as temp placeholder to avoid double-replacement
                  destpath=$(echo "$filename" | sed 's/__/\x00/g; s/_/\//g; s/\x00/_/g')
                  # Security: Reject paths with .. or starting with /
                  if echo "$destpath" | grep -qE '(^/|\.\.)'; then
                    echo "SECURITY: Rejecting invalid path: $destpath"
                    continue
                  fi
                  mkdir -p "$(dirname "/workspace/$destpath")"
                  cp "$file" "/workspace/$destpath"
                  echo "Copied: $destpath"
                fi
              done
              echo "=== Files copied ==="
              if [ -f /workspace/Dockerfile ]; then
                echo "=== Dockerfile ==="
                cat /workspace/Dockerfile
                echo "=== End Dockerfile ==="
              fi
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: generated-dockerfile
              mountPath: /generated
              readOnly: true
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "128Mi"
              cpu: "100m"
{{/dockerfileConfigMap}}
      containers:
        - name: kaniko
          image: gcr.io/kaniko-project/executor:latest
          args:
            - "--dockerfile={{dockerfilePath}}"
            - "--context=dir:///workspace"
            - "--destination={{imageDest}}"
            - "--cache=true"
            - "--cache-ttl=24h"
            - "--snapshot-mode=redo"
            - "--log-format=text"
            - "--skip-tls-verify"
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: docker-config
              mountPath: /kaniko/.docker
              readOnly: true
          resources:
            requests:
              memory: "2Gi"
              cpu: "500m"
            limits:
              memory: "4Gi"
              cpu: "2000m"
      volumes:
        - name: workspace
          emptyDir: {}
        - name: docker-config
          secret:
            secretName: {{registrySecretName}}
            items:
              - key: config.json
                path: config.json
{{#dockerfileConfigMap}}
        - name: generated-dockerfile
          configMap:
            name: {{dockerfileConfigMap}}
{{/dockerfileConfigMap}}
