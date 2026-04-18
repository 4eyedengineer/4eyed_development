import { useState, useEffect } from 'react'
import { Routes, Route, useNavigate, useLocation, useParams } from 'react-router-dom'
import {
  Layout,
  SidebarMenu,
  ToastProvider,
  useToast,
  TerminalSpinner,
  ErrorBoundary
} from './components'
import {
  Login,
  Dashboard,
  ProjectDetail,
  ServiceDetail,
  NewServiceForm,
  NewProjectWizard,
  Settings
} from './pages'
import { WebSocketProvider } from './context/WebSocketContext'
import { getCurrentUser, logout, getLoginUrl } from './api/auth'
import { fetchProject } from './api/projects'
import { createService } from './api/services'
import { ApiError } from './api/utils'

// Wrapper components for pages that need route params
function ProjectDetailPage({ user, onServiceClick }) {
  const { projectId, '*': tabPath } = useParams()
  const navigate = useNavigate()
  const toast = useToast()

  // Handle services/new as a special case (until Phase 4 removes this)
  if (tabPath === 'services/new') {
    const handleSubmit = async (data) => {
      try {
        const serviceData = {
          name: data.name,
          repo_url: data.image,
          port: data.port,
          branch: 'main',
          dockerfile_path: 'Dockerfile',
          replicas: data.replicas || 1,
          storage_gb: data.storage || null,
          health_check_path: data.healthCheckPath || null
        }
        await createService(projectId, serviceData)
        toast.success(`Service "${data.name}" created successfully`)
        navigate(`/projects/${projectId}`)
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Failed to create service'
        toast.error(message)
        throw err
      }
    }
    return (
      <NewServiceForm
        projectId={projectId}
        onSubmit={handleSubmit}
        onCancel={() => navigate(`/projects/${projectId}`)}
      />
    )
  }

  // Derive active tab from URL path
  const activeTab = tabPath || 'overview'

  return (
    <ProjectDetail
      projectId={projectId}
      activeTab={activeTab}
      onServiceClick={onServiceClick}
      onNewService={() => navigate(`/projects/${projectId}/services/new`)}
      onBack={() => navigate('/')}
      onTabChange={(tab) => {
        const basePath = `/projects/${projectId}`
        navigate(tab === 'overview' ? basePath : `${basePath}/${tab}`)
      }}
    />
  )
}

function ServiceDetailPage() {
  const { serviceId, '*': tabPath } = useParams()
  const navigate = useNavigate()

  // Derive active tab from URL path
  const activeTab = tabPath || 'overview'

  return (
    <ServiceDetail
      serviceId={serviceId}
      activeTab={activeTab}
      onBack={() => navigate(-1)}
      onTabChange={(tab) => {
        const basePath = `/services/${serviceId}`
        navigate(tab === 'overview' ? basePath : `${basePath}/${tab}`)
      }}
    />
  )
}

function NewProjectPage() {
  const navigate = useNavigate()

  const handleComplete = (project) => {
    navigate(`/projects/${project.id}`)
  }

  return (
    <NewProjectWizard
      onComplete={handleComplete}
      onCancel={() => navigate('/')}
    />
  )
}

function SettingsPage({ user, onLogout }) {
  return (
    <Settings
      user={user}
      onLogout={onLogout}
    />
  )
}

function DashboardPage() {
  const navigate = useNavigate()

  const handleServiceClick = (serviceId, tab = 'overview') => {
    const basePath = `/services/${serviceId}`
    navigate(tab === 'overview' ? basePath : `${basePath}/${tab}`)
  }

  return (
    <Dashboard
      onProjectClick={(project) => navigate(`/projects/${project.id}`)}
      onNewProject={() => navigate('/projects/new')}
      onServiceClick={handleServiceClick}
    />
  )
}

function AppContent() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()

  // Check authentication on mount
  useEffect(() => {
    checkAuth()
  }, [])

  const checkAuth = async () => {
    try {
      const userData = await getCurrentUser()
      setUser(userData)
    } catch (err) {
      // Not authenticated - this is expected for logged out users
      setUser(null)
    } finally {
      setAuthLoading(false)
    }
  }

  // Determine active nav based on current route
  const getActiveNav = () => {
    const path = location.pathname
    if (path.startsWith('/settings')) return 'Settings'
    // All project/service views are part of the Dashboard context
    return 'Dashboard'
  }

  const activeNav = getActiveNav()

  const navItems = [
    { label: 'Dashboard', href: '/', active: activeNav === 'Dashboard' },
    { label: 'Settings', href: '/settings', active: activeNav === 'Settings' },
    { label: 'Logout', href: '/logout', active: false }
  ]

  const handleNavClick = async (item) => {
    if (item.label === 'Logout') {
      try {
        await logout()
        setUser(null)
        navigate('/')
        toast.info('Logged out successfully')
      } catch (err) {
        toast.error('Failed to logout')
      }
      return
    }

    navigate(item.href)
  }

  const handleLogin = () => {
    window.location.href = getLoginUrl()
  }

  const handleServiceClick = (service) => {
    navigate(`/services/${service.id}`)
  }

  const getSidebarItems = () => {
    const path = location.pathname

    // Extract IDs from path for building hrefs
    const projectMatch = path.match(/^\/projects\/([^/]+)/)
    const serviceMatch = path.match(/^\/services\/([^/]+)/)

    // Detail pages render their own TerminalTabs row, so we suppress the
    // context sidebar on project/service routes to avoid duplicate nav.
    if (projectMatch || serviceMatch) {
      return []
    }
    // Dashboard - no navigation sidebar needed
    return []
  }

  const getBreadcrumbs = () => {
    const path = location.pathname
    const crumbs = []

    if (path === '/') {
      crumbs.push({ label: 'dashboard' })
    } else if (path === '/projects/new') {
      crumbs.push({ label: 'dashboard', href: '/' })
      crumbs.push({ label: 'new-project' })
    } else if (path.match(/^\/projects\/[^/]+\/services\/new$/)) {
      const projectPath = path.replace('/services/new', '')
      crumbs.push({ label: 'dashboard', href: '/' })
      crumbs.push({ label: 'project', href: projectPath })
      crumbs.push({ label: 'new-service' })
    } else if (path.match(/^\/projects\/([^/]+)(\/.*)?$/)) {
      const match = path.match(/^\/projects\/([^/]+)(\/(.*))?$/)
      const projectId = match[1]
      const tab = match[3]
      crumbs.push({ label: 'dashboard', href: '/' })
      crumbs.push({ label: 'project', href: `/projects/${projectId}` })
      if (tab) {
        crumbs.push({ label: tab })
      }
    } else if (path.match(/^\/services\/([^/]+)(\/.*)?$/)) {
      const match = path.match(/^\/services\/([^/]+)(\/(.*))?$/)
      const serviceId = match[1]
      const tab = match[3]
      crumbs.push({ label: 'dashboard', href: '/' })
      crumbs.push({ label: 'service', href: `/services/${serviceId}` })
      if (tab) {
        crumbs.push({ label: tab })
      }
    } else if (path === '/settings') {
      crumbs.push({ label: 'settings' })
    }

    return crumbs
  }

  // Show loading spinner while checking auth
  if (authLoading) {
    return (
      <div className="min-h-screen bg-terminal-primary terminal-grid-bg flex items-center justify-center">
        <div className="text-center">
          <TerminalSpinner className="text-2xl" />
          <p className="font-mono text-terminal-muted mt-4">Initializing...</p>
        </div>
      </div>
    )
  }

  // Show login page if not authenticated
  if (!user) {
    return <Login onLogin={handleLogin} />
  }

  const sidebarItems = getSidebarItems()
  const sidebarContent = sidebarItems.length > 0 ? (
    <SidebarMenu items={sidebarItems} />
  ) : null

  return (
    <Layout
      navItems={navItems}
      onNavClick={handleNavClick}
      breadcrumbs={getBreadcrumbs()}
      sidebarContent={sidebarContent}
      userName={user?.github_username}
    >
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:projectId/*" element={<ProjectDetailPage user={user} onServiceClick={handleServiceClick} />} />
        <Route path="/services/:serviceId/*" element={<ServiceDetailPage />} />
        <Route path="/settings" element={<SettingsPage user={user} onLogout={() => { setUser(null); navigate('/'); }} />} />
      </Routes>
    </Layout>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <WebSocketProvider>
          <AppContent />
        </WebSocketProvider>
      </ToastProvider>
    </ErrorBoundary>
  )
}

export default App
