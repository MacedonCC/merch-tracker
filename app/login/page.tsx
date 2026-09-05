'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase-client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
