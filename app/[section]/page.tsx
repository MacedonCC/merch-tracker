import { notFound, redirect } from 'next/navigation';
import { resolveViewer } from '@/lib/member';
import Header from '@/components/Header';
import TrackerSection, { type Section } from '@/components/TrackerSection';
import NotOnCommitteeList from '@/components/NotOnCommitteeList';

export const dynamic = 'force-dynamic';

const SECTIONS: Section[] = ['stock', 'handovers', 'restock', 'orders'];

export default async function SectionPage({ params }: { params: { section: string } }) {
  if (!SECTIONS.includes(params.section as Section)) notFound();

  const viewer = await resolveViewer();
  if (!viewer) redirect('/login');
  if (!viewer.member) return <NotOnCommitteeList email={viewer.email} />;

  return (
    <div className="shell">
      <Header userEmail={viewer.member.email} fullName={viewer.member.full_name} role={viewer.member.role} />
      <TrackerSection
        section={params.section as Section}
        userEmail={viewer.member.email}
        role={viewer.member.role}
      />
    </div>
  );
}
