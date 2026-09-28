export async function completeApproval(
  issueCode: () => Promise<{ redirectTo: string }>,
  activateGrant: () => Promise<void>,
) {
  const authorization = await issueCode()
  await activateGrant()
  return authorization
}
