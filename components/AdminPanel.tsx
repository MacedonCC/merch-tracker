'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase-client';

export interface MemberRow {
  id: string;
  email: string;
  full_name: string | null;
  role: 'admin' | 'helper';
  created_at: string;
}

export default function AdminPanel({
  initialMembers,
  selfEmail,
}: {
  initialMembers: MemberRow[];
  selfEmail: string;
}) {
  const supabase = createClient();
  const [members, setMembers] = useState<MemberRow[]>(initialMembers);
  const [modal, setModal] = useState(false);
  const [message, setMessage] = useState('');

  function flash(t: string) {
    setMessage(t);
    setTimeout(() => setMessage(''), 4000);
  }

  async function reload() {
    const { data } = await supabase
      .from('members')
      .select('id, email, full_name, role, created_at')
      .order('created_at');
    setMembers((data as MemberRow[]) ?? []);
  }

  async function toggleRole(m: MemberRow) {
    const next = m.role === 'admin' ? 'helper' : 'admin';
    const { error } = await supabase.from('members').update({ role: next }).eq('id', m.id);
    if (error) return flash(error.message);
    flash(`${m.email} is now ${next}.`);
    reload();
  }

  async function removeMember(m: MemberRow) {
    if (!confirm(`Remove ${m.email} from the committee list?`)) return;
    const { error } = await supabase.from('members').delete().eq('id', m.id);
    if (error) return flash(error.message);
    flash('Member removed.');
    reload();
  }

  async function addMember(form: HTMLFormElement) {
    const f = new FormData(form);
    const email = String(f.get('email') ?? '').trim().toLowerCase();
    if (!email) return flash('Email is required.');

    const { error } = await supabase.from('members').insert({
      email,
      full_name: String(f.get('full_name') ?? '').trim() || null,
      role: String(f.get('role') ?? 'helper'),
    });
    if (error) return flash(error.message);
    setModal(false);
    flash('Member added.');
    reload();
  }

  return (
    <>
      {message && <div className="note note-ok" style={{ marginBottom: '1rem' }}>{message}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Committee list</h2>
          <button className="btn-solid" onClick={() => setModal(true)}>Add member</button>
        </div>
        <table>
          <thead>
            <tr><th>Email</th><th>Name</th><th>Role</th><th>Joined</th><th></th></tr>
          </thead>
          <tbody>
            {members.length === 0 ? (
              <tr><td colSpan={5}><div className="empty">No members yet.</div></td></tr>
            ) : members.map((m) => {
              const isSelf = m.email.toLowerCase() === selfEmail.toLowerCase();
              return (
                <tr key={m.id}>
                  <td>{m.email}</td>
                  <td>{m.full_name ?? '—'}</td>
                  <td>
                    {m.role === 'admin'
                      ? <span className="pill pill-ok">Admin</span>
                      : <span className="pill pill-grey">Helper</span>}
                  </td>
                  <td style={{ fontSize: '0.8rem' }}>{new Date(m.created_at).toLocaleDateString('en-AU')}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn-mini"
                      disabled={isSelf}
                      title={isSelf ? "You can't change your own access here" : undefined}
                      onClick={() => toggleRole(m)}
                    >
                      Make {m.role === 'admin' ? 'helper' : 'admin'}
                    </button>
                    <button
                      className="btn-mini"
                      disabled={isSelf}
                      title={isSelf ? "You can't remove yourself" : undefined}
                      onClick={() => removeMember(m)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modal && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setModal(false)}>
          <form className="modal" onSubmit={(e) => { e.preventDefault(); addMember(e.currentTarget); }}>
            <h3>Add a member</h3>
            <div className="field"><label>Email</label><input name="email" type="email" autoFocus /></div>
            <div className="field"><label>Name (optional)</label><input name="full_name" /></div>
            <div className="field"><label>Role</label>
              <select name="role" defaultValue="helper">
                <option value="helper">Helper</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(false)}>Cancel</button>
              <button type="submit" className="btn-solid">Add member</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
