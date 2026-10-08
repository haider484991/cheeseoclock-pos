import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { normalizeDashUsername } from '@cheeseoclock/shared-types';
import { AuthCard } from '@/components/dashboard/AuthCard';
import { SetupForm } from '@/components/dashboard/AuthForms';
import { currentUser } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'First-time setup' };

export default async function SetupPage({ searchParams }: { searchParams: { u?: string } }) {
  if (await currentUser()) redirect('/dashboard');
  const username = typeof searchParams.u === 'string' ? normalizeDashUsername(searchParams.u).slice(0, 32) : '';
  return (
    <AuthCard
      title="First-time setup"
      lead="Type the username and the one-time setup code the owner gave you, then pick your own password. Only you will know it."
      foot="The code works once and runs out after three days. If it doesn’t work, ask the owner to make a new one on the till."
    >
      <SetupForm username={username} />
    </AuthCard>
  );
}
