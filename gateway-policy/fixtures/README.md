# Synthetic PII fixtures

Test data for the agentgateway guardrails (regex now, LLM judge later). **Every value
here is fictional and deliberately recognisable as fake** -- nothing belongs to a real
person, and none of it should ever be replaced with real data.

| File | Purpose |
| --- | --- |
| `people.csv` | 15 fictional people (superhero names) x name, street address, phone, email, SSN, card, bank routing/account. Source of truth for test cases. |
| `support-ticket.txt` | Realistic prose with PII embedded in free text -- the "paste a customer email into the agent" scenario. |
| `clean-control.txt` | Zero PII, but full of number-shaped strings (versions, ports, part numbers, dates). Must pass every guard untouched: the false-positive check. |

## Why these values are safe

- **SSNs** `987-65-43xx`: area numbers 900-999 are never issued as SSNs (and 987-65-4320
  to 4329 is the block the SSA reserves for advertising).
- **Phones** `212 555-01xx`: 555-0100 to 555-0199 is reserved for fictional use.
- **Emails** `@example.com`: reserved by RFC 2606.
- **Cards**: published processor test numbers (Stripe/Adyen/PayPal docs). They pass the
  Luhn check -- which is the point, since a validating regex should match them -- but
  charge nothing.
- **Bank**: routing `123456780` is the textbook ABA-checksum example, not a live bank;
  accounts are `0001234567xx`; the IBAN is the standard documentation example.
- **Addresses**: fictional streets in `Faketown ZZ 000xx` (`ZZ` is not a US state).

## How the tests will use them

Each column maps to a guard decision (configured in the guardrails step, asserted by
`gateway-policy/tests/`): SSN and card -> **reject**; email and phone -> **mask**;
street address and bank info -> not covered by any built-in, so they need a **custom
regex** (or the LLM judge) -- that gap is part of the story. `clean-control.txt` must
come through unchanged.

## Observed built-in behaviour (agentgateway v1.5.0)

Measured with these fixtures; the resulting policy is `../llm-guardrails.yaml`, asserted
by `../tests/test-regex-guardrails.sh`.

| Built-in | Result on the fixtures |
| --- | --- |
| `ssn` | Matches all 15 (`987-65-43xx`) -- and any bare 9-digit run, so ABA routing numbers are caught too. |
| `creditCard` | Misses spaced Amex (`3714 496353 98431`) and Mastercard 2-series (`2223 0031 ...`); 13/15 test numbers match. Custom patterns fill both gaps. |
| `email` | Matches all 15. |
| `phoneNumber` | Matches every phone format, but is greedy: also masks `4829-1173-0056` and `2026.10.04-117` in `clean-control.txt`. Replaced by a stricter custom pattern. |
| overlap | Built-ins overlap (`987-65-4321` is "a phone number" to `phoneNumber`), and guards run in order -- reject guards go first. |
| addresses, account numbers, IBAN | No built-in exists -> custom regex. |
| tool-result messages | Not scanned at all in v1.5.0 (known gap, pinned in the test). |
