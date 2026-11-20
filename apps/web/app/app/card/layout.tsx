import { UserShell } from '@/components/zecca/user-shell'

// /app/card sits outside the (space) route group (its folder belongs to the card feature), so it takes the shell here.
export default function CardLayout({ children }: { children: React.ReactNode }) {
  return <UserShell>{children}</UserShell>
}
