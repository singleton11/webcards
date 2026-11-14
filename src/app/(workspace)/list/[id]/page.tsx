import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ownerSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getCard } from "@/lib/cards";
import { CardDetails } from "@/components/card-details";
export const dynamic = "force-dynamic";
export default async function CardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await ownerSession(await headers());
  if (!session) redirect("/login");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const card = await getCard(getDb(), session.user.id, id);
  if (!card) notFound();
  return <CardDetails initialCard={card} />;
}
