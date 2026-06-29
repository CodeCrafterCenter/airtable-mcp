# Mixed-Packet Evidence Attachment Policy

When an `Attachment Intake Queue` record points to a packet that contains both safe distinct evidence and risky or duplicate-prone evidence, do not block the whole packet.

## Rule

Split the packet by file:

- Auto-attach high-confidence distinct screenshots, photos, images, and other low-risk files when the target record and attachment field are clear.
- Hold or skip only the ambiguous, duplicate-risk, legal/payment-sensitive, or consequence-changing files.
- Leave an audit note listing what was attached, what was skipped or held, and which claim/payment/legal conclusions were not changed.

## Human Review Boundary

Human review is still required before changing legal, coverage, claim, payment, liability, franchise recovery, cancellation, closure, deletion, merge, or outbound communication meaning.

A safe file attachment alone is not a claim/payment/legal conclusion.

## MCP Tool

Use `prepare_mixed_packet_attachment_plan` for this workflow.

The tool reads an intake record, classifies candidate files, returns file-level decisions, and can execute only safe attachments when `candidateFiles` include fetchable `fileUrl` values and `executeSafeAttachments` is true.

## Example

If a Gmail packet contains:

- `Screenshot 2026-06-10 at 15.22.32.heic`
- `CM ALFANO FACTURE 2642 CS INSIDE.pdf`

and the packet has duplicate risk because the invoice is already represented, the screenshot should still be attached to the claim evidence record. The invoice should remain held or skipped pending duplicate verification.
