import { useState, useEffect, useCallback, useRef } from 'react'

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api'

/**
 * Hook for streaming build logs via WebSocket
 * @param {string} deploymentId - The deployment ID to stream logs for
 * @param {boolean} enabled - Whether to enable the WebSocket connection
 * @returns {{ logs: string, status: string, statusMessage: string, error: string|null }}
 */
export function useBuildLogs(deploymentId, enabled = true) {
  const [logs, setLogs] = useState('')
  const [status, setStatus] = useState('idle') // idle, connecting, streaming, complete, error
  const [statusMessage, setStatusMessage] = useState('')
  const [error, setError] = useState(null)
  const wsRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)

  const connect = useCallback(() => {
    if (!deploymentId || !enabled) return

    // Build WebSocket URL
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const apiUrl = new URL(API_BASE_URL, window.location.origin)
    const basePath = apiUrl.pathname === '/' ? '' : apiUrl.pathname.replace(/\/$/, '')
    const wsUrl = `${wsProtocol}//${apiUrl.host}${basePath}/deployments/${deploymentId}/logs`

    setStatus('connecting')
    setStatusMessage('Connecting to build logs...')
    setError(null)

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('streaming')
      setStatusMessage('Connected')
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)

        switch (msg.type) {
          case 'log':
            setLogs(prev => prev + msg.data)
            setStatus('streaming')
            break

          case 'logs':
            // Bulk logs (for completed deployments)
            setLogs(msg.data || '')
            break

          case 'status':
            setStatusMessage(msg.message)
            break

          case 'complete':
            setStatus('complete')
            setStatusMessage(`Build ${msg.status === 'live' ? 'succeeded' : msg.status}`)
            break

          case 'error':
            setError(msg.message)
            setStatus('error')
            break

          default:
            console.warn('Unknown message type:', msg.type)
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err)
      }
    }

    ws.onerror = () => {
      setError('WebSocket connection error')
      setStatus('error')
    }

    ws.onclose = (event) => {
      if (event.code !== 1000 && event.code !== 1001) {
        // Abnormal close, might want to reconnect
        setError(`Connection closed: ${event.reason || 'Unknown reason'}`)
        setStatus('error')
      }
    }
  }, [deploymentId, enabled])

  // Connect when enabled and deploymentId changes
  useEffect(() => {
    if (enabled && deploymentId) {
      // Reset state for new deployment
      setLogs('')
      setError(null)
      setStatus('idle')
      setStatusMessage('')

      connect()
    }

    return () => {
      // Cleanup on unmount or when dependencies change
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounting')
        wsRef.current = null
      }
    }
  }, [deploymentId, enabled, connect])

  // Manual reconnect function
  const reconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setLogs('')
    setError(null)
    connect()
  }, [connect])

  return {
    logs,
    status,
    statusMessage,
    error,
    reconnect,
    isConnected: status === 'streaming',
    isComplete: status === 'complete',
    isError: status === 'error'
  }
}

export default useBuildLogs
