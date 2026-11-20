import { UserShell } from '@/components/zecca/user-shell'

// /app/market sits outside the (space) group (folder ownership), so it takes the same shell here.
export default function MarketLayout({ children }: { children: React.ReactNode }) {
  return <UserShell>{children}</UserShell>
}
