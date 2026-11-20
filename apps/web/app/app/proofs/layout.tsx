import { UserShell } from '@/components/zecca/user-shell'

// /app/proofs sits outside the (space) group (folder ownership), so it takes the same shell here.
export default function ProofsLayout({ children }: { children: React.ReactNode }) {
  return <UserShell>{children}</UserShell>
}
