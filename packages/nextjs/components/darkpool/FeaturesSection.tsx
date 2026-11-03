"use client";

import { motion } from "framer-motion";
import { EncryptedText } from "~~/components/darkpool/EncryptedText";

const FEATURES = [
  {
    id: "01",
    title: "Sealed Bids",
    description:
      "No participant can see others' bids until the auction closes. True dark-pool mechanics enforced by smart contract.",
  },
  {
    id: "02",
    title: "Immutable Rules",
    description: "Every parameter is locked at creation. Zero possibility of post-creation tampering by any party.",
    featured: true,
  },
  {
    id: "03",
    title: "Deposit Collateral",
    description: "All bids require ADI deposit as collateral. Prevents spam, ensures seriousness. Refunded on reveal.",
  },
  {
    id: "04",
    title: "KYB-Gated Access",
    description: "Only verified institutions can bid. Accreditation and jurisdiction rules are enforced on-chain.",
  },
  {
    id: "05",
    title: "Bid Updates",
    description: "Already committed? Replace your sealed bid with a new one any time before close.",
  },
  {
    id: "06",
    title: "Invite-Only Bidding",
    description: "Each auction whitelists the institutions allowed to bid. Control who participates.",
  },
  {
    id: "07",
    title: "On-Chain Transparency",
    description: "Every rule, commit, and settlement is verifiable on-chain. Full audit trail.",
  },
  {
    id: "08",
    title: "Trustless Settlement",
    description: "Winner selection is deterministic. No human intervention. Code is law.",
    featured: true,
  },
];

export function FeaturesSection() {
  return (
    <section className="border-t border-white bg-black px-6 py-20">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-16">
          <motion.p
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 0.4 }}
            viewport={{ once: true }}
            className="font-mono text-[10px] tracking-[0.2em] uppercase mb-4"
          >
            <EncryptedText text="[ CAPABILITIES ]" revealDelayMs={75} flipDelayMs={60} />
          </motion.p>
          <motion.h2
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="font-mono text-3xl sm:text-4xl font-bold tracking-[-0.03em] uppercase text-white"
          >
            <EncryptedText text="EVERYTHING AN AUCTION NEEDS." revealDelayMs={60} flipDelayMs={55} />
            <br />
            <EncryptedText text="NOTHING IT DOESN'T." revealDelayMs={60} flipDelayMs={55} />
          </motion.h2>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border-t border-l border-white">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.id}
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.05 }}
              className={`border-b border-r border-white p-6 hover:opacity-60 transition-all duration-100 group ${
                f.featured ? "sm:col-span-2 lg:col-span-2" : ""
              }`}
            >
              <p className="font-mono text-[10px] tracking-[0.2em] uppercase mb-6 opacity-100 group-hover:opacity-60">
                {f.id}
              </p>
              <h3 className="font-mono text-sm font-bold uppercase tracking-[0.05em] mb-3">
                <EncryptedText text={f.title} revealDelayMs={90} flipDelayMs={60} />
              </h3>
              <p className="font-mono text-xs leading-relaxed opacity-100 group-hover:opacity-80">{f.description}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
