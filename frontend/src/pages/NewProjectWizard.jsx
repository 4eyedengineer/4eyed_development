import { useState } from 'react'
import { TerminalCard, TerminalDivider } from '../components/TerminalCard'
import { WizardStepIndicator, CompactStepIndicator } from '../components/WizardStepIndicator'
import { RepoSelector } from '../components/RepoSelector'
import { ServiceTable } from '../components/ServiceTable'
import TerminalButton from '../components/TerminalButton'
import TerminalInput from '../components/TerminalInput'
import TerminalSpinner from '../components/TerminalSpinner'
import { useToast } from '../components/Toast'
import { createProject } from '../api/projects'
import { createServicesBatch, triggerDeploy } from '../api/services'
import { analyzeRepo } from '../api/github'
import { generateDockerfile } from '../api/dockerfile'

const STEPS = {
  NAME: 0,
  SOURCE: 1,
  REPO: 2,
  REVIEW: 3
}

const STEP_LABELS = [
  { label: 'NAME' },
  { label: 'SOURCE' },
  { label: 'REPO' },
  { label: 'REVIEW' }
]

export function NewProjectWizard({ onComplete, onCancel }) {
  const toast = useToast()

  // Wizard state
  const [currentStep, setCurrentStep] = useState(STEPS.NAME)
  const [projectName, setProjectName] = useState('')
  const [sourceType, setSourceType] = useState(null) // 'import' or 'empty'
  const [selectedRepo, setSelectedRepo] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [services, setServices] = useState([])

  // Loading/error states
  const [analyzing, setAnalyzing] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generationStatus, setGenerationStatus] = useState('')
  const [generatedInfo, setGeneratedInfo] = useState(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const [nameError, setNameError] = useState(null)

  // Validation
  const NAME_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/

  const validateProjectName = (name) => {
    if (!name) return 'Project name is required'
    if (name.length < 1 || name.length > 63) return 'Name must be 1-63 characters'
    if (!NAME_REGEX.test(name)) return 'Name must be lowercase, start with a letter, and contain only letters, numbers, and hyphens'
    if (name.includes('--')) return 'Name cannot contain consecutive hyphens'
    return null
  }

  // Step handlers
  const handleNameSubmit = (e) => {
    e?.preventDefault()
    const error = validateProjectName(projectName)
    if (error) {
      setNameError(error)
      return
    }
    setNameError(null)
    setCurrentStep(STEPS.SOURCE)
  }

  const handleSourceSelect = async (type) => {
    setSourceType(type)
    if (type === 'empty') {
      // Create empty project and complete
      await handleCreateEmptyProject()
    } else {
      setCurrentStep(STEPS.REPO)
    }
  }

  const handleRepoSelect = async (repo) => {
    setSelectedRepo(repo)
    setAnalyzing(true)
    setError(null)
    setGeneratedInfo(null)

    try {
      const result = await analyzeRepo(repo.url, repo.defaultBranch)
      setAnalysis(result)

      // Convert analysis to services array with selection state
      let allServices = [
        ...result.composeServices.map(s => ({
          ...s,
          selected: true
        })),
        ...result.standaloneDockerfiles.map(df => ({
          name: df.serviceName,
          type: 'container',
          image: null,
          build: {
            context: df.context,
            dockerfile: df.path.split('/').pop()
          },
          port: 8080,
          envVars: [],
          hasStorage: false,
          selected: true
        }))
      ]

      // If no services found, try to generate a Dockerfile with AI
      if (allServices.length === 0) {
        setAnalyzing(false)
        setGenerating(true)
        setGenerationStatus('Analyzing repository structure...')

        try {
          setGenerationStatus('Generating Dockerfile with AI...')
          const generated = await generateDockerfile(repo.url, repo.defaultBranch)

          if (generated.success) {
            setGeneratedInfo(generated)

            // Create a service from the generated Dockerfile
            allServices = [{
              name: projectName || repo.name || 'app',
              type: 'container',
              image: null,
              build: {
                context: '.',
                dockerfile: 'Dockerfile'
              },
              port: generated.detectedPort || 8080,
              envVars: [],
              hasStorage: false,
              selected: true,
              generated: true,
              framework: generated.framework
            }]

            setServices(allServices)
            setCurrentStep(STEPS.REVIEW)
          } else {
            setError('Failed to generate Dockerfile. Please add one manually.')
          }
        } catch (genErr) {
          console.error('Dockerfile generation failed:', genErr)
          setError(`No Dockerfile found and generation failed: ${genErr.message}`)
        } finally {
          setGenerating(false)
          setGenerationStatus('')
        }
        return
      }

      setServices(allServices)
      setCurrentStep(STEPS.REVIEW)
    } catch (err) {
      setError(err.message || 'Failed to analyze repository')
    } finally {
      setAnalyzing(false)
    }
  }

  const handleCreateEmptyProject = async () => {
    setCreating(true)
    setError(null)

    try {
      const project = await createProject(projectName)
      toast.success(`Project "${project.name}" created successfully`)
      onComplete(project)
    } catch (err) {
      setError(err.message || 'Failed to create project')
      setCreating(false)
    }
  }

  // Check for duplicate service names
  const getDuplicateNames = () => {
    const names = services.filter(s => s.selected).map(s => s.name)
    const seen = new Set()
    const duplicates = new Set()
    for (const name of names) {
      if (seen.has(name)) duplicates.add(name)
      seen.add(name)
    }
    return duplicates
  }

  const handleCreateWithServices = async () => {
    const selectedServices = services.filter(s => s.selected)
    if (selectedServices.length === 0) {
      setError('Please select at least one service')
      return
    }

    // Check for duplicate names
    const duplicates = getDuplicateNames()
    if (duplicates.size > 0) {
      setError(`Duplicate service names: ${Array.from(duplicates).join(', ')}. Please rename them.`)
      return
    }

    setCreating(true)
    setError(null)

    let project = null
    try {
      // Create project first
      project = await createProject(projectName)

      // Transform services for batch creation
      // If service has a build config, it needs repo_url to build from source
      // If service is image-only (no build), use the image directly
      const serviceData = selectedServices.map(s => ({
        name: s.name,
        port: s.port,
        // Only use image if this is NOT a build service
        image: s.build ? null : (s.image || null),
        // Use repo_url if this is a build service
        repo_url: s.build ? selectedRepo.url : null,
        branch: selectedRepo.defaultBranch,
        dockerfile_path: s.build?.dockerfile || 'Dockerfile',
        build_context: s.build?.context !== '.' ? s.build?.context : null,
        health_check_path: s.healthCheckPath || null,
        // Only include storage_gb when hasStorage is true (schema doesn't accept null)
        ...(s.hasStorage ? { storage_gb: 5 } : {}),
        env_vars: s.envVars || [],
        // Include generated Dockerfile if this service was AI-generated
        ...(s.generated && generatedInfo ? {
          generated_dockerfile: {
            dockerfile: generatedInfo.dockerfile,
            dockerignore: generatedInfo.dockerignore,
            framework: generatedInfo.framework
          }
        } : {})
      }))

      // Create services
      const result = await createServicesBatch(project.id, serviceData)

      if (result.summary.created > 0) {
        toast.success(`Created project with ${result.summary.created} service(s)`)
      }

      if (result.errors?.length > 0) {
        toast.warning(`${result.errors.length} service(s) failed to create`)
      }

      // Auto-deploy all created services
      if (result.created?.length > 0) {
        toast.info('Starting deployments...')
        const deployPromises = result.created.map(service =>
          triggerDeploy(service.id).catch(err => {
            console.error(`Failed to deploy ${service.name}:`, err)
            return null
          })
        )
        const deployResults = await Promise.all(deployPromises)
        const successfulDeploys = deployResults.filter(Boolean).length
        if (successfulDeploys > 0) {
          toast.success(`Triggered ${successfulDeploys} deployment(s)`)
        }
      }

      onComplete(project)
    } catch (err) {
      // If project was created but services failed, still navigate to project
      if (project) {
        toast.error(`Services failed: ${err.message}`)
        toast.info('Project created. You can add services manually.')
        onComplete(project)
      } else {
        setError(err.message || 'Failed to create project')
        setCreating(false)
      }
    }
  }

  const handleBack = () => {
    setError(null)
    if (currentStep === STEPS.SOURCE) {
      setCurrentStep(STEPS.NAME)
    } else if (currentStep === STEPS.REPO) {
      setCurrentStep(STEPS.SOURCE)
      setSelectedRepo(null)
    } else if (currentStep === STEPS.REVIEW) {
      setCurrentStep(STEPS.REPO)
      setAnalysis(null)
      setServices([])
    }
  }

  // Render steps
  const renderNameStep = () => (
    <TerminalCard title="PROJECT NAME" variant="green">
      <form onSubmit={handleNameSubmit} className="space-y-4">
        <div>
          <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
            Enter a name for your project
          </label>
          <TerminalInput
            value={projectName}
            onChange={(e) => {
              setProjectName(e.target.value.toLowerCase())
              setNameError(null)
            }}
            placeholder="my-project"
            className="w-full"
            autoFocus
          />
          {nameError && (
            <p className="font-mono text-xs text-terminal-red mt-2">! {nameError}</p>
          )}
          <p className="font-mono text-xs text-terminal-muted mt-2">
            Use lowercase letters, numbers, and hyphens only.
          </p>
        </div>
        <div className="flex justify-end gap-3">
          <TerminalButton type="button" variant="secondary" onClick={onCancel}>
            [ CANCEL ]
          </TerminalButton>
          <TerminalButton
            type="submit"
            variant="primary"
            disabled={!projectName}
          >
            [ CONTINUE ]
          </TerminalButton>
        </div>
      </form>
    </TerminalCard>
  )

  const renderSourceStep = () => (
    <div className="space-y-4">
      <p className="font-mono text-sm text-terminal-muted text-center">
        How would you like to set up your project?
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <button
          onClick={() => handleSourceSelect('import')}
          className="p-6 border-2 border-terminal-border hover:border-terminal-primary bg-terminal-bg-secondary transition-all text-left group"
        >
          <div className="font-mono text-lg text-terminal-primary group-hover:text-glow-green mb-2">
            IMPORT FROM GITHUB
          </div>
          <div className="font-mono text-xs text-terminal-muted">
            Select a repository and automatically detect services from docker-compose.yml or Dockerfiles
          </div>
          <div className="font-mono text-xs text-terminal-secondary mt-4">
            Recommended for existing projects
          </div>
        </button>

        <button
          onClick={() => handleSourceSelect('empty')}
          disabled={creating}
          className="p-6 border-2 border-terminal-border hover:border-terminal-secondary bg-terminal-bg-secondary transition-all text-left group disabled:opacity-50"
        >
          <div className="font-mono text-lg text-terminal-secondary group-hover:text-glow-amber mb-2">
            {creating ? 'CREATING...' : 'START EMPTY'}
          </div>
          <div className="font-mono text-xs text-terminal-muted">
            Create an empty project and add services manually later
          </div>
          <div className="font-mono text-xs text-terminal-muted mt-4">
            For new projects
          </div>
        </button>
      </div>

      <div className="flex justify-start">
        <TerminalButton variant="secondary" onClick={handleBack}>
          [ BACK ]
        </TerminalButton>
      </div>
    </div>
  )

  const renderRepoStep = () => (
    <div className="space-y-4">
      {analyzing || generating ? (
        <div className="text-center py-12">
          <TerminalSpinner className="text-2xl" />
          <p className="font-mono text-terminal-muted mt-4">
            {generating ? generationStatus : `Analyzing ${selectedRepo?.fullName}...`}
          </p>
          {generating && (
            <p className="font-mono text-xs text-terminal-secondary mt-2">
              AI is detecting your project type and generating a Dockerfile
            </p>
          )}
        </div>
      ) : (
        <>
          <TerminalCard title="SELECT REPOSITORY" variant="cyan">
            <RepoSelector
              onSelect={handleRepoSelect}
              onCancel={handleBack}
            />
          </TerminalCard>
        </>
      )}
    </div>
  )

  const renderReviewStep = () => (
    <div className="space-y-4">
      {/* Repository Info */}
      <TerminalCard title="REPOSITORY" variant="cyan">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-terminal-primary">{selectedRepo?.fullName}</div>
            <div className="text-xs text-terminal-muted mt-1">
              Branch: {analysis?.branch} |
              {analysis?.hasDockerCompose
                ? ` Compose: ${analysis.composeFile}`
                : ' No compose file'
              }
            </div>
          </div>
          <TerminalButton
            variant="secondary"
            onClick={() => {
              setCurrentStep(STEPS.REPO)
              setAnalysis(null)
              setServices([])
              setGeneratedInfo(null)
            }}
          >
            [ CHANGE ]
          </TerminalButton>
        </div>
      </TerminalCard>

      {/* AI-Generated Dockerfile Info */}
      {generatedInfo && (
        <TerminalCard title="AI GENERATED DOCKERFILE" variant="cyan">
          <div className="font-mono text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-terminal-muted">LANGUAGE:</span>
              <span className="text-terminal-primary">{generatedInfo.framework?.language || 'unknown'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-terminal-muted">FRAMEWORK:</span>
              <span className="text-terminal-primary">{generatedInfo.framework?.framework || 'none'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-terminal-muted">PORT:</span>
              <span className="text-terminal-cyan">{generatedInfo.detectedPort || '8080'}</span>
            </div>
            {generatedInfo.framework?.explanation && (
              <div className="mt-2 pt-2 border-t border-terminal-border">
                <p className="text-xs text-terminal-muted">{generatedInfo.framework.explanation}</p>
              </div>
            )}
          </div>
        </TerminalCard>
      )}

      {/* Services Table */}
      <TerminalCard title={generatedInfo ? "SERVICE (AI GENERATED)" : "DETECTED SERVICES"} variant="green">
        <ServiceTable
          services={services}
          onChange={setServices}
        />
      </TerminalCard>

      {/* Actions */}
      <div className="flex justify-between">
        <TerminalButton variant="secondary" onClick={handleBack}>
          [ BACK ]
        </TerminalButton>
        <TerminalButton
          variant="primary"
          onClick={handleCreateWithServices}
          disabled={creating || services.filter(s => s.selected).length === 0}
        >
          {creating ? '[ CREATING... ]' : '[ CREATE PROJECT ]'}
        </TerminalButton>
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => {
            // If past the first step, step back through the wizard preserving form state.
            // Only leave the wizard (cancel) when already on the first step.
            if (currentStep > STEPS.NAME) {
              handleBack()
            } else {
              onCancel()
            }
          }}
          className="font-mono text-terminal-secondary hover:text-terminal-primary transition-colors"
        >
          &lt; BACK
        </button>
        <h1 className="font-mono text-xl text-terminal-primary text-glow-green uppercase tracking-terminal-wide">
          NEW PROJECT
        </h1>
      </div>

      <TerminalDivider variant="double" color="green" />

      {/* Step Indicator */}
      <WizardStepIndicator
        steps={STEP_LABELS}
        currentStep={currentStep}
        className="mb-8"
      />

      {/* Error Display */}
      {error && (
        <TerminalCard variant="red" title="ERROR">
          <p className="font-mono text-terminal-red">{error}</p>
        </TerminalCard>
      )}

      {/* Step Content */}
      {currentStep === STEPS.NAME && renderNameStep()}
      {currentStep === STEPS.SOURCE && renderSourceStep()}
      {currentStep === STEPS.REPO && renderRepoStep()}
      {currentStep === STEPS.REVIEW && renderReviewStep()}
    </div>
  )
}

export default NewProjectWizard
