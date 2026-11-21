import { UserShell } from '@/components/zecca/user-shell'

// /app/withdraw sits outside the (space) route group (its folder belongs to the withdraw feature), so it takes the shell here.
export default function WithdrawLayout({ children }: { children: React.ReactNode }) {
  return <UserShell>{children}</UserShell>
}
