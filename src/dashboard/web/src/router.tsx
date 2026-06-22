import App from './App'
import { createDashboardRouter } from './router-factory'

export const router = createDashboardRouter(App)

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
