# Ephemeral sandbox Pod for the ReAct debug agent.
#
# Runs for at most 1 hour (activeDeadlineSeconds) and stays idle until the
# agent execs commands inside it. Workspace is an emptyDir — files are
# synced in from the local agent sandbox via `tar -x` over stdin on each
# run_command call. Destroyed in the agent's finally block.
#
# Template Variables:
#   podName    - Unique pod name (e.g. agent-sbx-<sessionId>-<short-uuid>)
#   namespace  - Kubernetes namespace (reuse the service's deployment namespace)
#   imageTag   - Base image (default node:20-bookworm-slim)
#   sessionId  - Debug session ID, recorded as a label
apiVersion: v1
kind: Pod
metadata:
  name: {{podName}}
  namespace: {{namespace}}
  labels:
    app: dangus-agent-sandbox
    session-id: {{sessionId}}
    managed-by: dangus-cloud
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 3600
  containers:
    - name: sandbox
      image: {{imageTag}}
      command: ["/bin/sh", "-c", "mkdir -p /workspace && sleep 3600"]
      workingDir: /workspace
      resources:
        requests:
          cpu: "500m"
          memory: "1Gi"
          ephemeral-storage: "2Gi"
        limits:
          cpu: "2000m"
          memory: "4Gi"
          ephemeral-storage: "10Gi"
      securityContext:
        runAsNonRoot: false
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: false
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: workspace
          mountPath: /workspace
  volumes:
    - name: workspace
      emptyDir:
        sizeLimit: "10Gi"
