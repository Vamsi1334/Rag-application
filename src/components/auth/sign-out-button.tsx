'use client';

import { useFormStatus } from 'react-dom';

/** Submit button with a pending state, for the sign-out Server Action. */
export function SignOutButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-line px-3 py-2 text-sm font-medium text-ink-soft transition hover:bg-canvas disabled:opacity-60"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
