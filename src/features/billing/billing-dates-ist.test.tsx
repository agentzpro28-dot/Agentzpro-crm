import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BillingOverview } from "@/lib/server/billing-service";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/services/billing-api-client", () => ({
  startCheckout: vi.fn(),
  getBillingStatus: vi.fn(),
}));

const { BillingPageClient } = await import("@/features/billing/billing-page-client");

// The server renders in UTC; Razorpay periods end at 18:30 UTC, which is midnight in India.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

function overview(): BillingOverview {
  return {
    tenantId: "tenant-1",
    companyName: "QA Test Co",
    isOwner: true,
    hasCrmAccess: true,
    isInternal: false,
    subscriptionStatus: "active",
    trialEndsAt: null,
    currentPeriodEndsAt: "2026-12-22T18:30:00Z",
    seats: { paidSeats: 1, activeMembers: 1, pendingInvitations: 0 },
    currentPlan: {
      planName: "Pro Monthly",
      billingPeriod: "monthly",
      pricePerSeatPaise: 49900,
      seatQuantity: 1,
      razorpayStatus: "active",
      cancelAtPeriodEnd: false,
    },
    canSubscribe: false,
    plans: [],
    payments: [
      {
        paymentId: "pay_1",
        amountPaise: 100,
        currency: "INR",
        paymentMethod: "upi",
        periodStart: "2026-11-22T18:30:00Z",
        periodEnd: "2026-12-22T18:30:00Z",
        paidAt: "2026-11-23T05:34:00Z",
        invoiceUrl: null,
      },
    ],
  } as BillingOverview;
}

describe("BillingPageClient: dates are shown in Indian time", () => {
  it("shows the India calendar day even when rendered in UTC", () => {
    render(<BillingPageClient overview={overview()} />);

    expect(screen.getByText("Renews on").nextElementSibling).toHaveTextContent("23 Dec 2026");
    expect(screen.getByText(/23 Nov 2026 · 23 Nov 2026 – 23 Dec 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/22 Dec 2026|22 Nov 2026/)).not.toBeInTheDocument();
  });
});
