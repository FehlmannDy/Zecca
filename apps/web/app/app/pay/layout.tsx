import { UserShell } from '@/components/zecca/user-shell'

// /app/pay lives outside the (space) group but gets the same shell.
export default function PayLayout({ children }: { children: React.ReactNode }) {
  return <UserShell>{children}</UserShell>
}
