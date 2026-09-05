export default function NotOnCommitteeList({ email }: { email: string }) {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Not on the committee list</h1>
        <p>
          {email} isn&apos;t authorised for this tracker. Ask an admin to add
          your email in Supabase, then sign in again.
        </p>
        <form action="/login"><button style={{ width: '100%' }}>Back to sign in</button></form>
      </div>
    </div>
  );
}
