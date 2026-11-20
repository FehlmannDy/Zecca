import { UserShell } from '@/components/zecca/user-shell'

// /app/earn sits outside the (space) route group (its folder belongs to the Earn feature), so it takes the shell here.
export default function EarnLayout({ children }: { children: React.ReactNode }) {
  return <UserShell>{children}</UserShell>
}
