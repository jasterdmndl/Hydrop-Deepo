import { type FormEvent, useState } from "react";
import { ApiError } from "../api";
import { useAuth } from "./AuthContext";

export function LoginPage({ notice }: { notice?: string }) {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Please try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="brand brand--dark">
          <span className="brand__name">Hydrop Deepo</span>
          <span className="brand__tag">Water refilling station</span>
        </div>
        <h1>Sign in</h1>
        {notice && (
          <p className="alert alert--info" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="alert alert--error" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>Username</span>
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button className="button button--primary button--block" type="submit" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="hint">Hand the tablet over only after signing out.</p>
      </form>
    </main>
  );
}
