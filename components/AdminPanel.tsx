'use client';

import { useState } from 'react';
import type { MemberPermissions } from '@/lib/member';

export interface MemberRow extends MemberPermissions {
  id: string;
  email: string;
  full_name: string | null;
  role: 'admin' | 'helper';
  created_at: string;
}

export interface InvitationRow extends MemberPermissions {
  id: string;
  email: string;
  role: 'admin' | 'helper';
  invited_by: string;
  invited_at: string;
  expires_at: string;
  status: 'pending' | 'accepted' | 'revoked';
}

const PERMISSIONS: { key: keyof MemberPermissions; label: string; title: string }[] = [
  { key: 'can_adjust_stock', label: 'Stock', title: 'Can change how much is on hand' },
  { key: 'can_change_prices', label: 'Prices', title: 'Can change item prices' },
  { key: 'can_change_targets', label: 'Targets', title: 'Can change low-stock and target levels' },
  { key: 'can_undo_handover', label: 'Undo', title: 'Can reverse a handover' },
];

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export default function AdminPanel({
  initialMembers,
  initialInvitations,
  selfId,
}: {
  initialMembers: MemberRow[];
  initialInvitations: InvitationRow[];
  selfId: string;
}) {
  const [members, setMembers] = useState<MemberRow[]>(initialMembers);
  const [invitations, setInvitations] = useState<InvitationRow[]>(initialInvitations);
  const [pending, setPending] = useState<Record<string, MemberPermissions>>({});
  const [message, setMessage] = useState('');

  function flash(t: string) {
    setMessage(t);
    setTimeout(() => setMessage(''), 5000);
  }

  function permValue(m: MemberRow, key: keyof MemberPermissions) {
    return pending[m.id]?.[key] ?? m[key];
  }

  function togglePerm(m: MemberRow, key: keyof MemberPermissions) {
    setPending((prev) => {
      const current = prev[m.id] ?? {
        can_adjust_stock: m.can_adjust_stock,
        can_change_prices: m.can_change_prices,
        can_change_targets: m.can_change_targets,
        can_undo_handover: m.can_undo_handover,
      };
      return { ...prev, [m.id]: { ...current, [key]: !current[key] } };
    });
  }

  // ---- Committee ------------------------------------------------------
  async function updateMember(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/members/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      flash(data.error ?? 'Update failed.');
      return null;
    }
    setMembers((prev) => prev.map((m) => (m.id === id ? (data.member as MemberRow) : m)));
    return data.member as MemberRow;
  }

  async function makeRole(m: MemberRow, role: 'admin' | 'helper') {
    const updated = await updateMember(m.id, { role });
    if (updated) flash(`${m.email} is now ${role}.`);
  }

  async function savePermissions(m: MemberRow) {
    const draft = pending[m.id];
    if (!draft) return;
    const updated = await updateMember(m.id, { ...draft });
    if (updated) {
      flash(`Permissions saved for ${m.email}.`);
      setPending((prev) => {
        const next = { ...prev };
        delete next[m.id];
        return next;
      });
    }
  }

  async function removeMember(m: MemberRow) {
    if (!confirm(`Remove ${m.email} from the committee list?`)) return;
    const res = await fetch(`/api/members/${m.id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return flash(data.error ?? 'Failed to remove member.');
    setMembers((prev) => prev.filter((x) => x.id !== m.id));
    flash('Member removed.');
  }

  // ---- Invitations ------------------------------------------------------
  async function sendInvitation(form: HTMLFormElement) {
    const f = new FormData(form);
    const email = String(f.get('email') ?? '').trim().toLowerCase();
    if (!email) return flash('Email is required.');

    const { ok, data } = await postJson('/api/invitations', {
      email,
      full_name: String(f.get('full_name') ?? '').trim() || null,
      role: String(f.get('role') ?? 'helper'),
      can_adjust_stock: f.get('can_adjust_stock') === 'on',
      can_change_prices: f.get('can_change_prices') === 'on',
      can_change_targets: f.get('can_change_targets') === 'on',
      can_undo_handover: f.get('can_undo_handover') === 'on',
    });
    if (!ok) return flash(data.error ?? 'Failed to send invitation.');

    form.reset();
    if (data.invitation) setInvitations((prev) => [data.invitation as InvitationRow, ...prev]);
    if (data.alreadyRegistered) {
      flash(`${email} already has an account — they can sign in normally and will get these permissions.`);
    } else if (data.invited) {
      flash(`Invited ${email}.`);
    } else {
      flash(`Invitation saved for ${email}, but the email failed to send${data.inviteError ? `: ${data.inviteError}` : '.'}`);
    }
  }

  async function resendInvitation(inv: InvitationRow) {
    const { ok, data } = await postJson(`/api/invitations/${inv.id}/resend`);
    if (!ok) return flash(data.error ?? 'Failed to re-send.');
    setInvitations((prev) => prev.map((i) => (i.id === inv.id ? (data.invitation as InvitationRow) : i)));
    flash(
      data.alreadyRegistered
        ? `${inv.email} already has an account — they can sign in normally.`
        : `Invitation re-sent to ${inv.email}.`
    );
  }

  async function revokeInvitation(inv: InvitationRow) {
    if (!confirm(`Revoke the invitation for ${inv.email}?`)) return;
    const { ok, data } = await postJson(`/api/invitations/${inv.id}/revoke`);
    if (!ok) return flash(data.error ?? 'Failed to revoke.');
    setInvitations((prev) => prev.filter((i) => i.id !== inv.id));
    flash(`Invitation for ${inv.email} revoked.`);
  }

  // ---- Add directly ------------------------------------------------------
  async function addDirect(form: HTMLFormElement) {
    const f = new FormData(form);
    const email = String(f.get('email') ?? '').trim().toLowerCase();
    if (!email) return flash('Email is required.');

    const { ok, data } = await postJson('/api/members', {
      email,
      full_name: String(f.get('full_name') ?? '').trim() || null,
      role: String(f.get('role') ?? 'helper'),
    });
    if (!ok) return flash(data.error ?? 'Failed to add member.');

    form.reset();
    if (data.member) {
      setMembers((prev) => [...prev, data.member as MemberRow].sort((a, b) => a.created_at.localeCompare(b.created_at)));
    }
    flash(`${email} added to the committee list.`);
  }

  return (
    <>
      {message && <div className="note note-ok" style={{ marginBottom: '1rem' }}>{message}</div>}

      {/* ---------------- Committee ---------------- */}
      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div className="card-head">
          <h2>Committee</h2>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Email</th><th>Name</th><th>Role</th><th>Joined</th>
                {PERMISSIONS.map((p) => (
                  <th key={p.key} className="perm-cell" title={p.title}>{p.label}</th>
                ))}
                <th></th><th></th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr><td colSpan={4 + PERMISSIONS.length + 2}><div className="empty">No members yet.</div></td></tr>
              ) : members.map((m) => {
                const isSelf = m.id === selfId;
                const isAdminRow = m.role === 'admin';
                const dirty = !!pending[m.id];
                return (
                  <tr key={m.id}>
                    <td>{m.email}</td>
                    <td>{m.full_name ?? '—'}</td>
                    <td>
                      {isAdminRow
                        ? <span className="pill pill-ok">Admin</span>
                        : <span className="pill pill-grey">Helper</span>}
                    </td>
                    <td style={{ fontSize: '0.8rem' }}>{new Date(m.created_at).toLocaleDateString('en-AU')}</td>
                    {PERMISSIONS.map((p) => (
                      <td key={p.key} className="perm-cell">
                        <input
                          type="checkbox"
                          checked={isAdminRow ? true : !!permValue(m, p.key)}
                          disabled={isAdminRow}
                          onChange={() => togglePerm(m, p.key)}
                        />
                      </td>
                    ))}
                    <td>
                      <button className="btn-mini" disabled={isAdminRow || !dirty} onClick={() => savePermissions(m)}>
                        Save
                      </button>
                    </td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn-mini"
                        disabled={isSelf}
                        title={isSelf ? "You can't change your own access" : undefined}
                        onClick={() => makeRole(m, isAdminRow ? 'helper' : 'admin')}
                      >
                        Make {isAdminRow ? 'helper' : 'admin'}
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
      </div>

      {/* ---------------- Invitations ---------------- */}
      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <div className="card-head">
          <h2>Invitations</h2>
        </div>
        <form
          style={{ padding: '1.15rem', borderBottom: '1px solid var(--line)' }}
          onSubmit={(e) => { e.preventDefault(); sendInvitation(e.currentTarget); }}
        >
          <div className="field-pair">
            <div className="field"><label>Email</label><input name="email" type="email" /></div>
            <div className="field"><label>Name (optional)</label><input name="full_name" /></div>
          </div>
          <div className="field"><label>Role</label>
            <select name="role" defaultValue="helper">
              <option value="helper">Helper</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="checkbox-group">
            {PERMISSIONS.map((p) => (
              <label key={p.key} className="checkbox-row" title={p.title}>
                <input type="checkbox" name={p.key} />
                {p.label}
              </label>
            ))}
          </div>
          <button type="submit" className="btn-solid">Send invitation</button>
        </form>
        <table>
          <thead>
            <tr><th>Email</th><th>Role</th><th>Invited by</th><th>Expires</th><th></th></tr>
          </thead>
          <tbody>
            {invitations.length === 0 ? (
              <tr><td colSpan={5}><div className="empty">No pending invitations.</div></td></tr>
            ) : invitations.map((inv) => {
              const expired = new Date(inv.expires_at) < new Date();
              return (
                <tr key={inv.id}>
                  <td>{inv.email}</td>
                  <td>{inv.role === 'admin' ? <span className="pill pill-ok">Admin</span> : <span className="pill pill-grey">Helper</span>}</td>
                  <td>{inv.invited_by}</td>
                  <td style={{ fontSize: '0.8rem' }}>
                    {new Date(inv.expires_at).toLocaleDateString('en-AU')}
                    {expired && <span className="pill pill-out" style={{ marginLeft: 6 }}>Expired</span>}
                  </td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-mini" onClick={() => resendInvitation(inv)}>Re-send</button>
                    <button className="btn-mini" onClick={() => revokeInvitation(inv)}>Revoke</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---------------- Add directly ---------------- */}
      <div className="card">
        <div className="card-head">
          <h2>Add directly</h2>
        </div>
        <form
          style={{ padding: '1.15rem' }}
          onSubmit={(e) => { e.preventDefault(); addDirect(e.currentTarget); }}
        >
          <div className="field-pair">
            <div className="field"><label>Email</label><input name="email" type="email" /></div>
            <div className="field"><label>Name (optional)</label><input name="full_name" /></div>
          </div>
          <div className="field"><label>Role</label>
            <select name="role" defaultValue="helper">
              <option value="helper">Helper</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button type="submit" className="btn-solid">Add member</button>
          <p style={{ fontSize: '0.78rem', color: 'var(--ink-faint)', marginTop: '0.75rem' }}>
            This creates the committee-list row without emailing an invitation — for fixing
            someone's role or adopting an account that already exists. Inviting is the normal
            way to bring on a new person.
          </p>
        </form>
      </div>
    </>
  );
}
