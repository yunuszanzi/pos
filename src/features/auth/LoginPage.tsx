import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "react-router-dom";
import { signInWithPassword, signUpOwner, requestPasswordReset, recordUserLogin } from "../../api/authApi";
import { requestApi } from "../../api/client";
import { useAuth } from "../../app/useAuth";
import { ErrorMessage, Field, SuccessMessage, TextInput } from "../../app/FormElements";
import { authCredentialsSchema } from "../../../shared/schemas/auth";
import type { z } from "zod";

export function LoginPage() {
  const navigate = useNavigate();
  const { refreshCurrentUser } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const form = useForm<z.input<typeof authCredentialsSchema>>({
    resolver: zodResolver(authCredentialsSchema),
    defaultValues: { email: "", password: "" },
  });
  const handleSubmit = form.handleSubmit(submit);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(values: z.input<typeof authCredentialsSchema>) {
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      if (mode === "reset") {
        await requestPasswordReset(values.email);
        setSuccess("If an account exists for this email, a reset link has been sent.");
        return;
      }
      if (!values.password || values.password.length < 8) {
        setError("Password must contain at least 8 characters");
        return;
      }
      const result = mode === "signin"
        ? await signInWithPassword(values.email, values.password)
        : await signUpOwner(values.email, values.password);
      if (result.error) throw result.error;
      if (!result.session) {
        setSuccess("Check your email to confirm the account, then sign in to continue.");
        return;
      }
      const user = await requestApi<{ userId: string | null }>("/me");
      if (user.userId) {
        await recordUserLogin();
        await refreshCurrentUser();
        navigate("/");
      } else {
        navigate("/setup");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const heading = mode === "signin" ? "Sign in" : mode === "signup" ? "Create owner account" : "Reset password";
  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">POS System · Foundation</p>
        <h1>{heading}</h1>
        <p className="muted">{mode === "signup" ? "Start by creating the business owner's account." : "Secure access for your business."}</p>
        <form className="stack" onSubmit={handleSubmit}>
          <Field label="Email">
            <TextInput autoComplete="email" type="email" {...form.register("email")} required />
          </Field>
          {mode !== "reset" && <Field label="Password">
            <TextInput autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} type="password" {...form.register("password")} required />
          </Field>}
          {form.formState.errors.email && <ErrorMessage>{form.formState.errors.email.message}</ErrorMessage>}
          {error && <ErrorMessage>{error}</ErrorMessage>}
          {success && <SuccessMessage>{success}</SuccessMessage>}
          <button className="button primary" disabled={busy}>{busy ? "Please wait…" : heading}</button>
        </form>
        <div className="auth-links">
          {mode === "signin" && <button className="text-button" onClick={() => setMode("reset")}>Forgot password?</button>}
          {mode !== "signin" && <button className="text-button" onClick={() => setMode("signin")}>Back to sign in</button>}
          {mode === "signin" && <button className="text-button" onClick={() => setMode("signup")}>Create a new business</button>}
        </div>
        <Link className="text-button" to="/">Return to app</Link>
      </section>
    </main>
  );
}
