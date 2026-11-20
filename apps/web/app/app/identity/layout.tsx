import { UserShell } from '@/components/zecca/user-shell'

// /app/identity sits outside the (space) group (folder ownership), so it takes the same shell here.
export default function IdentityLayout({ children }: { children: React.ReactNode }) {
  return <UserShell>{children}</UserShell>
}
