export default class Level6BubbleMapEngine {
  constructor(options = {}) {
    this.logger = options.logger || console;

    this.thresholds = {
      maxLargestClusterPct: this.#num(options.thresholds?.maxLargestClusterPct, 25),
      maxLinkedTopHolderPct: this.#num(options.thresholds?.maxLinkedTopHolderPct, 35),
      maxSuspiciousLinks: this.#num(options.thresholds?.maxSuspiciousLinks, 12),
      maxHubOutDegree: this.#num(options.thresholds?.maxHubOutDegree, 8),
      maxTop10ClusteredCount: this.#num(options.thresholds?.maxTop10ClusteredCount, 4)
    };
  }

  evaluate(input = {}) {
    const holders = this.#normalizeHolders(input.holders || []);
    const links = this.#normalizeLinks(input.links || []);
    const top10HolderPct = this.#num(input.top10HolderPct, null);

    if (!holders.length) {
      return {
        ok: true,
        clusterRiskScore: 0.35,
        largestClusterPct: 0,
        linkedTopHolderPct: 0,
        suspiciousLinksCount: 0,
        centralHubDetected: false,
        holderDistributionBand: "unknown",
        reasons: ["no_bubblemap_data"],
        details: {
          clusters: [],
          holdersCount: 0,
          linksCount: 0,
          top10HolderPct
        }
      };
    }

    const graph = this.#buildGraph(holders, links);
    const clusters = this.#findClusters(holders, graph);
    const clusterStats = this.#computeClusterStats(clusters, holders, graph);

    const largestClusterPct = clusterStats.largestClusterPct;
    const linkedTopHolderPct = clusterStats.linkedTopHolderPct;
    const suspiciousLinksCount = clusterStats.suspiciousLinksCount;
    const centralHubDetected = clusterStats.centralHubDetected;
    const top10ClusteredCount = clusterStats.top10ClusteredCount;

    let clusterRiskScore = 0.18;
    const reasons = [];

    if (largestClusterPct >= this.thresholds.maxLargestClusterPct) {
      clusterRiskScore += 0.32;
      reasons.push(`largest_cluster_too_large:${largestClusterPct}`);
    } else if (largestClusterPct >= this.thresholds.maxLargestClusterPct * 0.7) {
      clusterRiskScore += 0.16;
      reasons.push(`largest_cluster_watch:${largestClusterPct}`);
    } else {
      clusterRiskScore -= 0.04;
    }

    if (linkedTopHolderPct >= this.thresholds.maxLinkedTopHolderPct) {
      clusterRiskScore += 0.24;
      reasons.push(`linked_top_holder_pct_high:${linkedTopHolderPct}`);
    } else if (linkedTopHolderPct >= this.thresholds.maxLinkedTopHolderPct * 0.7) {
      clusterRiskScore += 0.12;
      reasons.push(`linked_top_holder_pct_watch:${linkedTopHolderPct}`);
    }

    if (suspiciousLinksCount >= this.thresholds.maxSuspiciousLinks) {
      clusterRiskScore += 0.14;
      reasons.push(`suspicious_links_high:${suspiciousLinksCount}`);
    } else if (suspiciousLinksCount > 0) {
      clusterRiskScore += 0.05;
    }

    if (centralHubDetected) {
      clusterRiskScore += 0.22;
      reasons.push("central_hub_detected");
    }

    if (top10ClusteredCount >= this.thresholds.maxTop10ClusteredCount) {
      clusterRiskScore += 0.16;
      reasons.push(`top10_clustered_count_high:${top10ClusteredCount}`);
    }

    if (top10HolderPct !== null && top10HolderPct <= 45 && largestClusterPct <= 12) {
      clusterRiskScore -= 0.08;
      reasons.push("holder_distribution_healthy");
    }

    clusterRiskScore = this.#clamp(clusterRiskScore, 0, 1);

    let holderDistributionBand = "safe";
    if (clusterRiskScore >= 0.72) holderDistributionBand = "danger";
    else if (clusterRiskScore >= 0.48) holderDistributionBand = "watch";

    const hardReject =
      centralHubDetected ||
      largestClusterPct >= this.thresholds.maxLargestClusterPct ||
      linkedTopHolderPct >= this.thresholds.maxLinkedTopHolderPct;

    return {
      ok: !hardReject,
      hardReject,
      clusterRiskScore,
      largestClusterPct,
      linkedTopHolderPct,
      suspiciousLinksCount,
      centralHubDetected,
      holderDistributionBand,
      reasons,
      details: {
        clusters: clusterStats.clusters,
        holdersCount: holders.length,
        linksCount: links.length,
        top10HolderPct,
        top10ClusteredCount,
        hubAddresses: clusterStats.hubAddresses
      }
    };
  }

  #normalizeHolders(holders) {
    return holders
      .map((h, index) => ({
        address: String(h.address || h.owner || h.wallet || `holder_${index}`).trim(),
        pct: this.#num(h.pct ?? h.percent ?? h.sharePct ?? h.percentage, 0),
        rank: this.#num(h.rank, index + 1)
      }))
      .filter(h => h.address);
  }

  #normalizeLinks(links) {
    return links
      .map(l => ({
        from: String(l.from || l.source || "").trim(),
        to: String(l.to || l.target || "").trim(),
        weight: this.#num(l.weight ?? l.strength, 1)
      }))
      .filter(l => l.from && l.to);
  }

  #buildGraph(holders, links) {
    const graph = new Map();

    for (const holder of holders) {
      graph.set(holder.address, new Set());
    }

    for (const link of links) {
      if (!graph.has(link.from)) graph.set(link.from, new Set());
      if (!graph.has(link.to)) graph.set(link.to, new Set());
      graph.get(link.from).add(link.to);
      graph.get(link.to).add(link.from);
    }

    return graph;
  }

  #findClusters(holders, graph) {
    const visited = new Set();
    const clusters = [];
    const addresses = holders.map(h => h.address);

    for (const address of addresses) {
      if (visited.has(address)) continue;

      const queue = [address];
      const cluster = [];
      visited.add(address);

      while (queue.length) {
        const cur = queue.shift();
        cluster.push(cur);

        const neighbors = [...(graph.get(cur) || [])];
        for (const next of neighbors) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  #computeClusterStats(clusters, holders, graph) {
    const holderMap = new Map(holders.map(h => [h.address, h]));
    const top10 = holders
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 10)
      .map(h => h.address);

    const outDegreeMap = new Map();
    for (const holder of holders) {
      outDegreeMap.set(holder.address, (graph.get(holder.address) || new Set()).size);
    }

    const hubAddresses = [...outDegreeMap.entries()]
      .filter(([, degree]) => degree >= this.thresholds.maxHubOutDegree)
      .map(([address]) => address);

    const clusterObjects = clusters.map((cluster, index) => {
      const members = cluster.map(addr => holderMap.get(addr)).filter(Boolean);
      const pct = this.#sum(members.map(m => m.pct), 0);
      const top10Count = members.filter(m => top10.includes(m.address)).length;
      return {
        id: `cluster_${index + 1}`,
        size: members.length,
        pct,
        top10Count,
        members: members.map(m => m.address)
      };
    });

    clusterObjects.sort((a, b) => b.pct - a.pct);

    const largestClusterPct = this.#num(clusterObjects[0]?.pct, 0);

    const linkedTopHolderPct = this.#sum(
      clusterObjects
        .filter(c => c.top10Count >= 2)
        .map(c => c.pct),
      0
    );

    const suspiciousLinksCount = [...outDegreeMap.values()].filter(
      degree => degree >= 3
    ).length;

    const centralHubDetected = hubAddresses.length > 0;

    const top10ClusteredCount = clusterObjects
      .filter(c => c.top10Count >= 2)
      .reduce((acc, c) => acc + c.top10Count, 0);

    return {
      largestClusterPct,
      linkedTopHolderPct,
      suspiciousLinksCount,
      centralHubDetected,
      top10ClusteredCount,
      clusters: clusterObjects.slice(0, 8),
      hubAddresses
    };
  }

  #sum(arr, fallback = 0) {
    if (!Array.isArray(arr) || !arr.length) return fallback;
    return arr.reduce((acc, x) => acc + this.#num(x, 0), 0);
  }

  #num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  #clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
}
