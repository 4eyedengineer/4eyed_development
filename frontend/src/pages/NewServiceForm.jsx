import { useState } from 'react'
import { TerminalCard, TerminalDivider } from '../components/TerminalCard'
import TerminalButton from '../components/TerminalButton'
import TerminalInput from '../components/TerminalInput'
import TerminalSelect from '../components/TerminalSelect'
import TerminalSlider from '../components/TerminalSlider'

export function NewServiceForm({ projectId, onSubmit, onCancel }) {
  const [formData, setFormData] = useState({
    name: '',
    type: '',
    image: '',
    port: '',
    replicas: 1,
    storage: 1,
    cpuLimit: '500m',
    memoryLimit: '512Mi',
    healthCheckPath: '/health',
    envVars: [{ key: '', value: '' }]
  })

  const [errors, setErrors] = useState({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const serviceTypes = [
    { value: 'container', label: 'Container' },
    { value: 'database', label: 'Database' },
    { value: 'cache', label: 'Cache' },
    { value: 'queue', label: 'Message Queue' }
  ]

  const cpuOptions = [
    { value: '250m', label: '250m (0.25 CPU)' },
    { value: '500m', label: '500m (0.5 CPU)' },
    { value: '1000m', label: '1000m (1 CPU)' },
    { value: '2000m', label: '2000m (2 CPU)' }
  ]

  const memoryOptions = [
    { value: '256Mi', label: '256 Mi' },
    { value: '512Mi', label: '512 Mi' },
    { value: '1Gi', label: '1 Gi' },
    { value: '2Gi', label: '2 Gi' },
    { value: '4Gi', label: '4 Gi' }
  ]

  const handleInputChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))

    // Clear error when field is modified
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: null }))
    }
  }

  const handleEnvVarChange = (index, field, value) => {
    const newEnvVars = [...formData.envVars]
    newEnvVars[index] = { ...newEnvVars[index], [field]: value }
    setFormData(prev => ({ ...prev, envVars: newEnvVars }))
  }

  const addEnvVar = () => {
    setFormData(prev => ({
      ...prev,
      envVars: [...prev.envVars, { key: '', value: '' }]
    }))
  }

  const removeEnvVar = (index) => {
    if (formData.envVars.length > 1) {
      setFormData(prev => ({
        ...prev,
        envVars: prev.envVars.filter((_, i) => i !== index)
      }))
    }
  }

  const validateForm = () => {
    const newErrors = {}

    if (!formData.name.trim()) {
      newErrors.name = 'Service name is required'
    } else if (!/^[a-z0-9-]+$/.test(formData.name)) {
      newErrors.name = 'Only lowercase letters, numbers, and hyphens allowed'
    }

    if (!formData.type) {
      newErrors.type = 'Service type is required'
    }

    if (!formData.image.trim()) {
      newErrors.image = 'Container image is required'
    }

    if (!formData.port) {
      newErrors.port = 'Port is required'
    } else if (isNaN(formData.port) || formData.port < 1 || formData.port > 65535) {
      newErrors.port = 'Port must be between 1 and 65535'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    setIsSubmitting(true)

    try {
      // Filter out empty env vars
      const cleanedData = {
        ...formData,
        port: parseInt(formData.port, 10),
        envVars: formData.envVars.filter(env => env.key.trim() !== '')
      }

      await onSubmit?.(cleanedData)
    } catch (err) {
      console.error('Failed to create service:', err)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={onCancel}
          className="font-mono text-terminal-secondary hover:text-terminal-primary transition-colors"
        >
          ◄ CANCEL
        </button>
        <h1 className="font-mono text-xl text-terminal-primary text-glow-green uppercase tracking-terminal-wide">
          NEW SERVICE
        </h1>
      </div>

      <TerminalDivider variant="double" color="green" />

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Configuration */}
        <TerminalCard title="Basic Configuration" variant="green">
          <div className="space-y-4">
            {/* Service Name */}
            <div>
              <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
                Service Name *
              </label>
              <TerminalInput
                name="name"
                value={formData.name}
                onChange={handleInputChange}
                placeholder="my-service"
                className="w-full"
              />
              {errors.name && (
                <p className="font-mono text-xs text-terminal-red mt-1">
                  ! {errors.name}
                </p>
              )}
            </div>

            {/* Service Type */}
            <div>
              <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
                Service Type *
              </label>
              <TerminalSelect
                name="type"
                value={formData.type}
                onChange={handleInputChange}
                options={serviceTypes}
                placeholder="Select type..."
                className="w-full"
              />
              {errors.type && (
                <p className="font-mono text-xs text-terminal-red mt-1">
                  ! {errors.type}
                </p>
              )}
            </div>

            {/* Container Image */}
            <div>
              <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
                Container Image *
              </label>
              <TerminalInput
                name="image"
                value={formData.image}
                onChange={handleInputChange}
                placeholder="nginx:latest"
                className="w-full"
              />
              {errors.image && (
                <p className="font-mono text-xs text-terminal-red mt-1">
                  ! {errors.image}
                </p>
              )}
            </div>

            {/* Port */}
            <div>
              <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
                Port *
              </label>
              <TerminalInput
                name="port"
                type="number"
                value={formData.port}
                onChange={handleInputChange}
                placeholder="8080"
                className="w-full"
              />
              {errors.port && (
                <p className="font-mono text-xs text-terminal-red mt-1">
                  ! {errors.port}
                </p>
              )}
            </div>
          </div>
        </TerminalCard>

        {/* Advanced toggle — boundary between essential and advanced fields */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setShowAdvanced(prev => !prev)}
            className="font-mono text-sm text-terminal-secondary hover:text-terminal-primary transition-colors uppercase tracking-terminal-wide"
            aria-expanded={showAdvanced}
          >
            {showAdvanced ? '[-] HIDE ADVANCED' : '[+] SHOW ADVANCED'}
          </button>
        </div>

        {showAdvanced && (
        <>
        {/* Resource Allocation */}
        <TerminalCard title="Resource Allocation" variant="amber">
          <div className="space-y-6">
            {/* Replicas Slider */}
            <TerminalSlider
              name="replicas"
              value={formData.replicas}
              onChange={handleInputChange}
              min={1}
              max={3}
              step={1}
              unit="replica(s)"
              label="REPLICAS"
            />

            {/* Storage Slider */}
            <TerminalSlider
              name="storage"
              value={formData.storage}
              onChange={handleInputChange}
              min={1}
              max={100}
              step={1}
              unit="GB"
              label="STORAGE"
            />

            {/* CPU Limit */}
            <div>
              <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
                CPU Limit
              </label>
              <TerminalSelect
                name="cpuLimit"
                value={formData.cpuLimit}
                onChange={handleInputChange}
                options={cpuOptions}
                className="w-full"
              />
            </div>

            {/* Memory Limit */}
            <div>
              <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
                Memory Limit
              </label>
              <TerminalSelect
                name="memoryLimit"
                value={formData.memoryLimit}
                onChange={handleInputChange}
                options={memoryOptions}
                className="w-full"
              />
            </div>
          </div>
        </TerminalCard>

        {/* Health Check */}
        <TerminalCard title="Health Check" variant="cyan">
          <div>
            <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
              Health Check Path
            </label>
            <TerminalInput
              name="healthCheckPath"
              value={formData.healthCheckPath}
              onChange={handleInputChange}
              placeholder="/health"
              className="w-full"
            />
          </div>
        </TerminalCard>

        {/* Environment Variables */}
        <TerminalCard title="Environment Variables" variant="green">
          <div className="space-y-3">
            {formData.envVars.map((env, index) => (
              <div key={index} className="flex items-center gap-2">
                <TerminalInput
                  value={env.key}
                  onChange={(e) => handleEnvVarChange(index, 'key', e.target.value)}
                  placeholder="KEY"
                  className="flex-1"
                />
                <span className="text-terminal-muted font-mono">=</span>
                <TerminalInput
                  value={env.value}
                  onChange={(e) => handleEnvVarChange(index, 'value', e.target.value)}
                  placeholder="value"
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={() => removeEnvVar(index)}
                  className="font-mono text-terminal-red hover:text-terminal-red/80 text-sm px-2"
                  disabled={formData.envVars.length === 1}
                >
                  [X]
                </button>
              </div>
            ))}

            <button
              type="button"
              onClick={addEnvVar}
              className="font-mono text-sm text-terminal-secondary hover:text-terminal-primary transition-colors"
            >
              + Add Variable
            </button>
          </div>
        </TerminalCard>
        </>
        )}

        {/* Form Actions */}
        <TerminalDivider variant="single" color="muted" />

        <div className="flex items-center justify-between">
          <div className="font-mono text-xs text-terminal-muted">
            * Required fields
          </div>
          <div className="flex gap-3">
            <TerminalButton
              type="button"
              variant="secondary"
              onClick={onCancel}
            >
              [ CANCEL ]
            </TerminalButton>
            <TerminalButton
              type="submit"
              variant="primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? '[ CREATING... ]' : '[ CREATE SERVICE ]'}
            </TerminalButton>
          </div>
        </div>
      </form>
    </div>
  )
}

export default NewServiceForm
