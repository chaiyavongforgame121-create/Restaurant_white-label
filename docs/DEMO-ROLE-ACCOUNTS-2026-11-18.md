# Demo store: one login per role — 2026-11-18 (owner request)

"For the demo store only, add users split by role, e.g. admin@favornoms.com, cashier@favornoms.com,
so each role can try it and see what it sees."

Created on 2026-11-18 at restaurant 3333 (**Demo-FavorNoms**), every branch (staff row with no
branch), active, email confirmed, **no password** (one `demo_staff_created` audit row each):

| Login | Role | Lands on | Sees |
|---|---|---|---|
| admin@favornoms.com | Admin | Back office dashboard | Everything the owner sees except Plan & billing and HQ: menu, orders, refunds, staff (can invite everyone but admins), branch settings, payments, reports |
| manager@favornoms.com | Manager | Back office dashboard | Menu, orders and refunds, promos, inventory, reports, delivery, time log; no staff management or branch settings |
| cashier@favornoms.com | Cashier | Counter (till) | Till, orders, customers, payments to verify, promos to apply, receipts; the back office dashboard |
| server@favornoms.com | Server | Counter | Taking orders and seeing their own; kitchen status |
| kitchen@favornoms.com | Kitchen | Kitchen display | The kitchen board and marking dishes sold out |

Not created, on purpose:
- **Owner**: Plan & billing and payouts. The demo store must stay at $0 until 2099 (see the demo
  store note); an owner login shared with prospects could change its plan or payment details.
- **Driver**: a driver online receives real delivery offers from real restaurants nearby
  (Thai Burrito is in Texas too).

## Setting the passwords (the owner does this)

Sign in to the Supabase dashboard, open **SQL Editor** for the project, and run, with your own
password in place of `YOUR-PASSWORD` (one password for all five, or run it once per address):

```sql
update auth.users
   set encrypted_password = extensions.crypt('YOUR-PASSWORD', extensions.gen_salt('bf')),
       updated_at = now()
 where email in ('admin@favornoms.com', 'manager@favornoms.com', 'cashier@favornoms.com',
                 'server@favornoms.com', 'kitchen@favornoms.com');
```

Then sign in at admin.favornoms.com/login with the address and that password. (If these
addresses receive mail, "Forgot password?" on the sign-in page works too.)

## Things to know before sharing them

- Anyone with these logins changes the real demo store: an admin or manager can edit the menu and
  prices; an admin can invite staff, which sends real emails from FavorNoms. Change the password
  to cut access.
- Orders placed from the counter with these logins are real orders of the demo store and appear
  on its kitchen board.
- To remove one: Staff page of the demo store → Remove, then Delete (Delete is refused once it
  has orders, payments or shifts on record, which then stay as history; its sign-in stays until
  deleted in Supabase Authentication).
