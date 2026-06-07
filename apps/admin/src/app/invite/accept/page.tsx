import { AcceptInviteView } from './_components/accept-invite-view';

interface Props {
  searchParams: Promise<{ staff_id?: string }>;
}

export default async function AcceptInvitePage({ searchParams }: Props) {
  const { staff_id } = await searchParams;
  return <AcceptInviteView staffId={staff_id} />;
}
