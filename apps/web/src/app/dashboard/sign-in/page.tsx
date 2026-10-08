import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/dashboard/AuthCard';
import { SignInForm } from '@/components/dashboard/AuthForms';
import { currentUser, safeNext } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = safeNext(searchParams.next);
  if (await currentUser()) redirect(next);
  return (
    <AuthCard
      title="Sign in"
      lead="Orders, shifts, cash, stock and sales from the shop’s tills, on your phone."
      foot="No sign-in yet? The owner adds you on the till: Settings → Online orders → Phone dashboard, and gives you a one-time setup code."
    >
      <SignInForm next={next} />
    </AuthCard>
  );
}
