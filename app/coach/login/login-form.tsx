"use client";

import { useActionState } from "react";
import { Loader2, LockKeyhole, TriangleAlert } from "lucide-react";

import { signInAction, type LoginState } from "@/app/coach/login/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initialState: LoginState = { error: null };

interface LoginFormProps {
  redirectTo?: string;
}

export function LoginForm({ redirectTo }: LoginFormProps) {
  const [state, formAction, pending] = useActionState(
    signInAction,
    initialState
  );

  return (
    <form action={formAction} className="space-y-4 text-left">
      <input type="hidden" name="redirect" value={redirectTo ?? ""} />

      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="coach@advanceacademy.uk"
          required
          disabled={pending}
          className="h-11"
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          required
          disabled={pending}
          className="h-11"
        />
      </div>

      {state.error && (
        <p
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <TriangleAlert className="size-4 shrink-0" />
          {state.error}
        </p>
      )}

      <Button
        type="submit"
        variant="highlight"
        disabled={pending}
        className="h-11 w-full"
      >
        {pending ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Signing in…
          </>
        ) : (
          <>
            <LockKeyhole className="size-4" />
            Sign in
          </>
        )}
      </Button>
    </form>
  );
}
