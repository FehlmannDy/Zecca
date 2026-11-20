import { UserShell } from '@/components/zecca/user-shell'

// Every signed-in user screen (/app, /app/send, /app/pay, ...) goes in this route group to get the shell.
export default function SpaceLayout({ children }: { children: React.ReactNode }) {
  return <UserShell>{children}</UserShell>
}
