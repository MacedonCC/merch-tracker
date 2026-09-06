'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase-client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  async function signInWithGoogle() {
    setError('');
    setGoogleBusy(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });

    // On success, Supabase redirects the browser to Google — this only
    // returns (with an error) if that redirect couldn't be started.
    if (error) {
      setError(error.message);
      setGoogleBusy(false);
    }
  }

  async function sendLink() {
    if (!email.trim()) {
      setError('Enter your email address.');
      return;
    }
    setBusy(true);
    setError('');

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });

    setBusy(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Merchandise Tracker</h1>
        <p>Committee access only. We&apos;ll email you a sign-in link.</p>

        {sent ? (
          <div className="note note-ok">
            Check your inbox. The link signs you in and expires after an hour.
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn-google"
              style={{ width: '100%' }}
              onClick={signInWithGoogle}
              disabled={googleBusy}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
                <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" />
                <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
                <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
              </svg>
              {googleBusy ? 'Redirecting…' : 'Continue with Google'}
            </button>

            <div className="divider"><span>or</span></div>

            <div className="field">
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                value={email}
                placeholder="name@gmail.com"
                onChange={(e) => { setEmail(e.target.value); setError(''); }}
                onKeyDown={(e) => e.key === 'Enter' && sendLink()}
              />
            </div>
            <button className="btn-solid" style={{ width: '100%' }} onClick={sendLink} disabled={busy}>
              {busy ? 'Sending…' : 'Email me a link'}
            </button>
            {error && <div className="note note-bad">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
