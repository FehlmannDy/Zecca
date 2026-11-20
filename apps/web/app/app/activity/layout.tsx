import { SpaceGate } from '@/components/send/space-gate'

// Outside the (space) group, so this layout brings the user shell itself (and returns here after sign-up).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <SpaceGate>{children}</SpaceGate>
}
