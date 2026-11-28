import { redirect } from "next/navigation";
import { getChannelPath } from "@/lib/channels-path-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The Team & roles page is gone: the product has the operator and users, each user owns their own workspace, and
 * nobody is added to anyone else's (migrations 0091 and 0233 closed the database doors behind it). An old bookmark
 * lands on Settings instead of a 404, which is where the account it was really about lives.
 */
export default async function MembersMoved() {
  const path = await getChannelPath();
  redirect(path("/organization"));
}
