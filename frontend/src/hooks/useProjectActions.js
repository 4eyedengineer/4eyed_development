import { useState, useCallback } from 'react'
import { startProject, stopProject, updateProject, deleteProject } from '../api/projects'
import { deleteService } from '../api/services'
import { ApiError } from '../api/utils'
import { useToast } from '../components/Toast'

/**
 * Hook for project action handlers (start/stop, rename, delete, delete-service).
 * Collapses per-action boolean flags into a single `pending` object.
 *
 * @param {string} projectId
 * @param {object} opts
 * @param {Function} opts.refetch - Refetch project after successful mutations
 * @param {Function} [opts.onDeleted] - Called after the project is deleted
 * @returns {{
 *   actions: {
 *     startProject: Function,
 *     stopProject: Function,
 *     updateProject: Function,
 *     deleteProject: Function,
 *     deleteService: Function
 *   },
 *   pending: {
 *     changingState: boolean,
 *     savingName: boolean,
 *     deletingProject: boolean,
 *     deletingService: boolean
 *   }
 * }}
 */
export function useProjectActions(projectId, { refetch, onDeleted } = {}) {
  const toast = useToast()

  const [pending, setPending] = useState({
    changingState: false,
    savingName: false,
    deletingProject: false,
    deletingService: false
  })

  const setFlag = useCallback((key, value) => {
    setPending(prev => ({ ...prev, [key]: value }))
  }, [])

  const startAll = useCallback(async () => {
    setFlag('changingState', true)
    try {
      await startProject(projectId)
      toast.success('All services started')
      if (refetch) await refetch()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to start project'
      toast.error(message)
    } finally {
      setFlag('changingState', false)
    }
  }, [projectId, toast, refetch, setFlag])

  const stopAll = useCallback(async () => {
    setFlag('changingState', true)
    try {
      await stopProject(projectId)
      toast.success('All services stopped')
      if (refetch) await refetch()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to stop project'
      toast.error(message)
    } finally {
      setFlag('changingState', false)
    }
  }, [projectId, toast, refetch, setFlag])

  const rename = useCallback(async (newName) => {
    setFlag('savingName', true)
    try {
      await updateProject(projectId, { name: newName })
      toast.success('Project renamed successfully')
      if (refetch) await refetch()
      return true
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to rename project'
      toast.error(message)
      return false
    } finally {
      setFlag('savingName', false)
    }
  }, [projectId, toast, refetch, setFlag])

  const remove = useCallback(async (projectName) => {
    setFlag('deletingProject', true)
    try {
      await deleteProject(projectId)
      toast.success(`Project "${projectName}" deleted successfully`)
      if (onDeleted) onDeleted()
      return true
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to delete project'
      toast.error(message)
      return false
    } finally {
      setFlag('deletingProject', false)
    }
  }, [projectId, toast, onDeleted, setFlag])

  const removeService = useCallback(async (service) => {
    setFlag('deletingService', true)
    try {
      await deleteService(service.id)
      if (refetch) await refetch()
      toast.success(`Service "${service.name}" deleted successfully`)
      return true
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to delete service'
      toast.error(message)
      return false
    } finally {
      setFlag('deletingService', false)
    }
  }, [toast, refetch, setFlag])

  return {
    actions: {
      startProject: startAll,
      stopProject: stopAll,
      updateProject: rename,
      deleteProject: remove,
      deleteService: removeService
    },
    pending
  }
}

export default useProjectActions
