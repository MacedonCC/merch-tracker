import { redirect } from 'next/navigation';
import { resolveViewer } from '@/lib/member';
import Header from '@/components/Header';
import HomeTiles from '@/components/HomeTiles';
import NotOnCommitteeList from '@/components/NotOnCommitteeList';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const viewer = await resolveViewer();
  if (!viewer) redirect('/login');
  if (!viewer.member) return <NotOnCommitteeList email={viewer.email} />;

  return (
    <>
      <Header userEmail={viewer.member.email} fullName={viewer.member.full_name} role={viewer.member.role} />
      <div className="shell">
        <HomeTiles role={viewer.member.role} />
      </div>
    </>
  );
}
