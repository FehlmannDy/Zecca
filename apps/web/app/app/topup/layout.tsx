import { UserShell } from '@/components/zecca/user-shell'

// Outside the (space) group (this folder is the top-up's own), so the layout brings the shared user shell itself.
export default function TopupLayout({ children }: { children: React.ReactNode }) {
  return <UserShell>{children}</UserShell>
}
