# conn_u50_cfg — U50 HBM Connection Configuration

Imagine you are designing a multi-lane highway system to allow hundreds of trucks (data) to travel simultaneously between warehouses (DRAM) and factories (FPGA compute units). If all trucks crowd into a single lane, even the widest road will cause severe congestion. `conn_u50_cfg` is the **traffic planning blueprint** for this highway—it precisely specifies how the PageRank kernel's 8 data channels map to the 16 HBM (High Bandwidth Memory) stacks on the Alveo U50 card to maximize parallel data throughput.

---

## 1. Problem Space and Design Motivation

### 1.1 The Memory Wall Bottleneck

The PageRank algorithm is a **memory-intensive** workload: each iteration requires random access to large-scale graph structure data (edge lists, vertex scores). On FPGA accelerator cards, the processing speed of compute logic often far exceeds the bandwidth supply capacity of a single memory port. This creates the so-called "Memory Wall"—even if the FPGA has ample parallel compute resources, it will frequently stall due to insufficient data supply.

### 1.2 HBM's Parallel Potential

The Alveo U50 card is equipped with 16 independent HBM2 stacks (typically labeled HBM[0] through HBM[15]), each providing independent physical channels and controllers. In theory, if data access can be evenly distributed across all these independent channels, the aggregate bandwidth can reach hundreds of GB/s, far exceeding that of a single DDR or single HBM stack.

### 1.3 Why Explicit Configuration is Needed

Xilinx Vitis compiler's default memory mapping strategy is typically conservative—it may bind all `m_axi` interfaces to the same HBM stack, or employ simple interleaving strategies, without fully understanding the specific access patterns of each data channel in the PageRank kernel (e.g., which ports read edge data, which ports read/write vertex attributes).

The core purpose of `conn_u50_cfg` is to **manually orchestrate the mapping of the kernel's AXI master interfaces to physical HBM stacks through explicit connectivity directives**, ensuring high-throughput data flows can fully leverage the HBM parallel architecture of the U50 card.

---

## 2. Core Configuration Analysis

### 2.1 Connectivity Directives Overview

```cfg
[connectivity]
sp = kernel_pagerank_0.m_axi_gmem0:HBM[0]
sp = kernel_pagerank_0.m_axi_gmem1:HBM[2:3]
sp = kernel_pagerank_0.m_axi_gmem2:HBM[4:5]
sp = kernel_pagerank_0.m_axi_gmem3:HBM[6:7]
sp = kernel_pagerank_0.m_axi_gmem4:HBM[8:9]
sp = kernel_pagerank_0.m_axi_gmem5:HBM[10:11]
sp = kernel_pagerank_0.m_axi_gmem6:HBM[12:13]
sp = kernel_pagerank_0.m_axi_gmem7:HBM[1]
slr = kernel_pagerank_0:SLR0
nk = kernel_pagerank_0:1:kernel_pagerank_0
```

### 2.2 Directive Type Details

#### 2.2.1 `sp` — Stream Port / AXI Master Interface Mapping

**Syntax**: `sp = <kernel_instance>.<m_axi_interface>:<memory_resource>`

The `sp` directive (sometimes also understood as "scalable port" or "stream port") is the core of the configuration, binding a specific AXI4-Full (`m_axi`) master interface of a kernel instance to a target memory resource.

In our configuration, the PageRank kernel exposes 8 AXI master interfaces: `m_axi_gmem0` through `m_axi_gmem7`. This multi-interface design itself is intended to allow the kernel to simultaneously initiate multiple independent memory transaction streams, avoiding single-bus contention.

**HBM Mapping Strategy Analysis**:

| AXI Interface | Mapping Target | Strategic Intent |
|--------------|----------------|------------------|
| `m_axi_gmem0` | HBM[0] | Independent single stack, likely for small-size, high-frequency access control data or index tables |
| `m_axi_gmem1` | HBM[2:3] | Dual-stack interleaving, used for medium-granularity edge data or vertex attribute streams, doubled bandwidth |
| `m_axi_gmem2` | HBM[4:5] | Same as above, possibly corresponding to different graph partitions or alternating access patterns |
| `m_axi_gmem3` | HBM[6:7] | Same as above |
| `m_axi_gmem4` | HBM[8:9] | Same as above |
| `m_axi_gmem5` | HBM[10:11] | Same as above |
| `m_axi_gmem6` | HBM[12:13] | Same as above |
| `m_axi_gmem7` | HBM[1] | Back to single stack, possibly symmetric with gmem0, used for result output or another control flow |

**Range Notation `HBM[a:b]`**: When a range is specified, the Vitis compiler typically implements **interleaving** access between these HBM stacks. This means consecutive memory addresses are automatically distributed to different HBM stacks within the specified range, thereby balancing access pressure from a single logical data flow across multiple physical channels to maximize aggregate bandwidth.

#### 2.2.2 `slr` — Super Logic Region Placement

**Syntax**: `slr = <kernel_instance>:<SLR_id>`

The `slr` directive places a kernel instance into a specific **Super Logic Region** of the FPGA chip. Modern FPGAs (such as Xilinx UltraScale+) typically divide programmable logic into multiple SLRs, each being a relatively independent silicon area connected through special interconnect structures.

In our configuration, `slr = kernel_pagerank_0:SLR0` explicitly places the PageRank kernel in **SLR0** (the first Super Logic Region).

**Design Considerations**:
- **Timing Closure**: Fixing the kernel to a specific SLR helps the compiler with timing analysis and optimization, avoiding timing violations caused by excessively long cross-SLR signal paths
- **Resource Isolation**: Clearly delineating SLR boundaries facilitates resource planning for multi-kernel designs, preventing resource contention between different functional modules
- **HBM Physical Proximity**: The U50 card's HBM controllers are typically physically close to specific SLRs. Placing the kernel in SLR0 may shorten the routing distance to HBM controllers, reducing signal latency

#### 2.2.3 `nk` — Number of Kernel Instances

**Syntax**: `nk = <kernel_name>:<num_instances>:<base_instance_name>`

The `nk` directive ("number of kernels") defines the **number of kernel copies** instantiated from the same RTL/HLS kernel description.

In our configuration, `nk = kernel_pagerank_0:1:kernel_pagerank_0` means:
- Instantiate **1** copy of `kernel_pagerank`
- The instance name is `kernel_pagerank_0`

**Single Instance Design Implications**:
The PageRank benchmark test chooses a **single kernel large-scale parallel** strategy rather than a **multi-kernel partitioning** strategy. This means:
- A single large kernel implements a highly parallel PageRank compute pipeline internally
- All HBM channels are exclusively accessed by this sole kernel, avoiding arbitration and synchronization overhead between multiple kernels
- This design is suitable for scenarios where a single graph is extremely large and requires high-bandwidth, low-latency access

In contrast, multi-instance configurations (such as `nk=4:kernel_pagerank`) are typically used for **data partitioning parallelism**—the entire graph is divided into 4 subgraphs, each kernel processes one partition, and results are merged at the end.

---

## 3. Architectural Context and Data Flow

### 3.1 Position in the PageRank Benchmark

`conn_u50_cfg` is part of the [pagerank_base_benchmark](graph-l2-benchmarks-pagerank-base-benchmark.md) module, specifically responsible for **Alveo U50 platform physical connectivity configuration**. The complete PageRank system architecture can be viewed as three layers:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Host Application Layer                      │
│         (OpenCL/XRT API calls, graph data preparation)         │
├─────────────────────────────────────────────────────────────────┤
│                  XCLBIN / FPGA Bitstream                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │         kernel_pagerank_0 (HLS/RTL Kernel)              │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  │   │
│  │  │ Compute │→ │ Compute │→ │ Compute │→ │ Compute │  │   │
│  │  │ Engine 0│  │ Engine 1│  │ Engine 2│  │ Engine N│  │   │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  │   │
│  │       └────────────┴────────────┴────────────┘       │   │
│  │              ↑         ↑         ↑         ↑          │   │
│  │         m_axi_gmem0  gmem1     gmem2     gmem3...    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ↓                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Connectivity Layer (conn_u50_cfg)            │   │
│  │  ┌──────────┬──────────┬──────────┬──────────┬─────────┐ │   │
│  │  │ HBM[0]   │ HBM[1]   │ HBM[2:3] │ HBM[4:5] │ ...     │ │   │
│  │  └──────────┴──────────┴──────────┴──────────┴─────────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 End-to-End Data Flow Tracing

Let's trace data flow during a typical PageRank iteration:

**Phase 1: Graph Data Loading (Host → HBM)**
1. Host application reads graph file in CSR (Compressed Sparse Row) format
2. Allocates HBM buffers via XRT API, writes edge lists (`source[], destination[]`) and vertex scores (`rank[]`) to HBM
3. Key: Host must organize data according to `conn_u50_cfg`'s mapping strategy—for example, placing frequently accessed edge data in HBM[2:3] and HBM[4:5] regions so the kernel's `m_axi_gmem1` and `m_axi_gmem2` interfaces can read in interleaved parallel fashion

**Phase 2: Kernel Execution (FPGA Internal Pipeline)**
1. Host launches `kernel_pagerank_0`, passing HBM buffer pointers and graph parameters (vertex count, edge count)
2. Kernel's internal dataflow engine begins operation:
   - **Edge traversal unit** reads source vertex IDs via `m_axi_gmem1` (HBM[2:3]) and destination vertex IDs via `m_axi_gmem2` (HBM[4:5])
   - **Score accumulation unit** reads source vertex's current PageRank score via `m_axi_gmem0` (HBM[0])
   - **Update writeback unit** writes newly computed scores back via `m_axi_gmem7` (HBM[1])
3. Key point: Because `conn_u50_cfg` maps different AXI interfaces to different HBM stacks, these memory accesses can happen **truly in parallel** rather than serially contending for the same bus

**Phase 3: Result Transfer and Iteration (HBM → Host)**
1. When kernel completes an iteration, Host reads updated score array from HBM[1]
2. Checks convergence condition (score delta below threshold); if not converged, Host swaps read/write buffer pointers and launches next iteration

### 3.3 Module Dependency Relationships

**Upstream Dependencies (callers/configurers of this module)**:
- [pagerank_base_benchmark](graph-l2-benchmarks-pagerank-base-benchmark.md): As part of the benchmark suite, references this configuration file when building XCLBIN
- Vitis compiler (`v++`): Reads this `.cfg` file during the linking phase (`--link`), parses connectivity directives, and generates actual FPGA placement and routing constraints

**Downstream Dependencies (this module depends on/configures)**:
- `kernel_pagerank_0` (HLS/RTL kernel): The kernel instance referenced in the configuration; its `m_axi` interface names must exactly match those defined in the HLS code
- U50 Platform Shell: The underlying static logic defines SLR layout, HBM controller positions, and AXI interconnect topology; this configuration must work within the physical constraints provided by the Shell

---

## 4. Design Decisions and Tradeoff Analysis

### 4.1 Memory Mapping Strategy: Scatter vs. Aggregate

**Observed Strategy**: The configuration scatters 8 AXI interfaces across 14 HBM stacks (HBM[0] through HBM[13]), using a mixed pattern of single-stack and dual-stack interleaving.

**Alternative 1: Full Aggregate Mapping**
- Map all `m_axi_gmem*` to a single HBM[0]
- **Pros**: Simple programming model, Host only needs to manage one contiguous buffer; no need to consider data alignment and partitioning
- **Cons**: All memory accesses serialize, bandwidth limited to a single HBM stack (~10-15 GB/s), PageRank kernel will idle extensively waiting for data

**Alternative 2: Fully Uniform Interleaving**
- Map each AXI interface to interleaved address spaces across all 16 HBM stacks
- **Pros**: Automatic load balancing, no need to care about data placement
- **Cons**:
  - **Row buffer contention**: HBM's row buffers are limited within each stack. If multiple AXI streams simultaneously access different rows mapped to the same stack, it causes frequent row activate/precharge (row miss), significantly increasing latency
  - **Address calculation overhead**: Hardware interleaving logic increases access latency

**Tradeoff of Selected Strategy**: The **partition-dedicated + partial interleaving** strategy adopted by the configuration represents a balance point between performance and complexity:
- **gmem0 and gmem7 map to single stacks** (HBM[0] and HBM[1]): Likely for control data and result output with lower bandwidth requirements, avoiding interleaving overhead
- **gmem1 through gmem6 use dual-stack interleaving** (HBM[2:3] through HBM[12:13]): For high-bandwidth data streams (edge lists, vertex attributes), doubling bandwidth through interleaving while limiting row buffer contention to just 2 stacks

### 4.2 SLR Placement: Why SLR0?

**Decision**: Fixed placement of kernel in SLR0 via `slr = kernel_pagerank_0:SLR0`

**Alternative: Compiler Auto-placement**
- Let Vitis compiler automatically decide kernel placement based on timing and resource constraints
- **Pros**: Compiler has global view, may find better placement for complex multi-kernel designs
- **Cons**: Unpredictable placement may cause:
  - Long paths from kernel to HBM controllers, failing timing closure
  - Difficulty in meeting setup/hold times for high-frequency kernel clocks

**Rationale for Explicit SLR0 Placement**:
- **Physical proximity**: U50's HBM PHYs (physical layer interfaces) are typically located near SLR0. Placing the kernel in the same SLR minimizes routing delay between kernel logic and HBM controllers
- **Timing predictability**: Explicit placement eliminates compiler guesswork, ensuring consistent timing results across builds
- **Single-kernel optimization**: With only one kernel instance, there's no need to balance multiple kernels across SLRs; concentrating resources in SLR0 allows for dense, high-performance implementation

### 4.3 Single Kernel Instance vs. Multiple Smaller Kernels

**Decision**: Single kernel instance via `nk = kernel_pagerank_0:1:kernel_pagerank_0`

**Alternative: Data-Parallel Multiple Kernels**
- Instantiate 4-8 smaller PageRank kernels, each processing a graph partition
- **Pros**:
  - Natural scaling to larger graphs by adding more kernels
  - Simpler per-kernel logic, potentially higher clock frequency
  - Can pipeline graph partitioning and computation across different kernels
- **Cons**:
  - **Partition overhead**: Graph partitioning for PageRank is non-trivial; edges crossing partitions require expensive inter-kernel communication or iterative fixup passes
  - **HBM channel contention**: Multiple kernels competing for the same 16 HBM stacks require complex arbitration logic, potentially reducing effective bandwidth
  - **Load imbalance**: Real-world graphs have power-law degree distributions; simple edge-cut partitioning leads to severe load imbalance across kernels

**Rationale for Single Large Kernel**:
- **Bandwidth monopoly**: The single kernel gets exclusive access to all 8 AXI interfaces mapped across 14 HBM stacks, eliminating arbitration overhead and maximizing burst efficiency
- **On-chip flexibility**: A single kernel can implement sophisticated load balancing and vertex/edge scheduling logic on-chip, using FPGA's fine-grained parallelism to handle graph skew
- **Software simplicity**: Host application deals with a single kernel launch per iteration, avoiding complex multi-kernel orchestration and synchronization
- **Scale-up focus**: The design targets "scale-up" (larger graphs on single card) rather than "scale-out" (multiple cards), optimizing for the common case of single-accelerator deployment

---

## 5. Operational Considerations and Pitfalls

### 5.1 Host-Side Buffer Allocation Alignment

**Critical Requirement**: When allocating buffers in host code for `m_axi_gmem*` interfaces mapped to HBM, you **must** ensure proper alignment for the interleaving scheme.

**For single-stack mappings (gmem0→HBM[0], gmem7→HBM[1])**:
- Allocate buffers using `xrt::bo` with appropriate flags
- No special interleaving alignment needed, but ensure 4KB page alignment for efficient DMA

**For dual-stack interleaving (gmem1→HBM[2:3], etc.)**:
- The Vitis runtime automatically handles address interleaving across HBM[2] and HBM[3]
- **Critical**: Buffer size should be a multiple of the interleaving granularity (typically 4KB or 8KB) to avoid partial-line writes that could corrupt data or reduce efficiency
- Use `xrt::bo::flags::host_only` or `device_only` as appropriate, ensuring buffer objects are created with sizes aligned to 4KB boundaries

**Pitfall**: Misaligned buffers or non-multiple sizes for interleaved regions can cause:
- Silent data corruption when writes straddle interleaving boundaries
- Reduced effective bandwidth due to partial-line reads/writes
- Vitis runtime errors during buffer allocation or kernel launch

### 5.2 AXI Interface Naming Consistency

**Critical Requirement**: The `m_axi_gmem*` names in the connectivity configuration **must exactly match** the interface names declared in the HLS kernel source code.

**HLS Code Side**:
```cpp
// In kernel_pagerank.cpp
void kernel_pagerank(
    // These pragma-declared interfaces must match the .cfg file
    ap_uint<512>* gmem0,  // Maps to m_axi_gmem0
    ap_uint<512>* gmem1,  // Maps to m_axi_gmem1
    ap_uint<512>* gmem2,  // Maps to m_axi_gmem2
    // ... gmem3 through gmem7
    int num_vertices,
    int num_edges
) {
    #pragma HLS INTERFACE m_axi port=gmem0 bundle=gmem0 depth=65536
    #pragma HLS INTERFACE m_axi port=gmem1 bundle=gmem1 depth=65536
    #pragma HLS INTERFACE m_axi port=gmem2 bundle=gmem2 depth=65536
    // ... additional pragmas for gmem3-7
}
```

**Naming Rules**:
- The `bundle=name` in HLS pragma corresponds to `m_axi_name` in the `.cfg` file
- Case sensitivity matters: `gmem0` ≠ `Gmem0` ≠ `GMEM0`
- Index numbering must be contiguous and match exactly: if HLS declares gmem0-gmem7, the cfg must reference exactly those 8 interfaces

**Pitfall - Mismatched Names**: If the `.cfg` file references `m_axi_gmem0` but the HLS code declares `bundle=data0`, the Vitis linker will fail with an error like:
```
ERROR: [VPL 60-895] The specified interface 'm_axi_gmem0' is not found in the kernel 'kernel_pagerank'
```

### 5.3 HBM Resource Exhaustion and OOM

**Constraint**: While the U50 has 16 HBM stacks, not all may be available to user kernels, and each has finite capacity.

**Physical Limits**:
- U50 total HBM capacity: Typically 8GB or 16GB (depending on specific SKU)
- Per-stack capacity: If total is 8GB across 16 stacks, each stack holds ~512MB
- Available stacks: Some stacks may be reserved by the platform shell for DMA, XRT metadata, or other system functions

**Configuration Analysis**:
Our `conn_u50_cfg` uses HBM[0] through HBM[13], leaving HBM[14] and HBM[15] potentially available for system use or future expansion.

**Pitfall - Overallocation**: If the Host application attempts to allocate buffers larger than the per-stack capacity mapped in the cfg:
- Example: Mapping gmem1 to HBM[2:3] (interleaved) but requesting a 2GB buffer when each of HBM[2] and HBM[3] only has 512MB
- Result: `xrt::bo` allocation will throw `std::bad_alloc` or XRT error `NO_DEVICE_MEMORY`

**Mitigation**:
- Query HBM capacity via `xrt::device::get_info` before allocation
- Implement buffer chunking: If a single buffer exceeds per-stack capacity, split into multiple buffers mapped to different stack ranges
- Use the `size` parameter in `sp` directives to hint expected buffer sizes to the Vitis compiler for better resource planning

### 5.4 Timing Closure and Frequency Scaling

**Challenge**: High-bandwidth HBM designs often struggle with timing closure due to long paths from kernel logic through AXI interconnects to HBM PHYs.

**Configuration Safeguards**:
- The `slr=SLR0` directive helps by localizing kernel logic close to HBM controllers
- The specific HBM-to-interface mapping was likely chosen based on physical layout—stacks physically closer to SLR0 (where the kernel is placed) get the highest-bandwidth mappings

**Pitfall - Frequency Degradation**: If timing closure fails, Vitis may:
- Automatically reduce kernel clock frequency (from target 300MHz down to 250MHz or lower)
- This directly impacts throughput: At II=1, 300MHz = 3.33ns/sample, but 250MHz = 4ns/sample (20% throughput loss)
- Report timing violations as critical warnings that may be buried in build logs

**Mitigation**:
- Always check post-route timing reports (`*_timing_summary_postroute_physopted.rpt`)
- If timing fails on HBM paths, consider:
  - Relaxing the target frequency via `--kernel_frequency` option and compensating with increased parallelism
  - Simplifying kernel logic to reduce combinatorial depth before AXI interfaces
  - Using `clock_uncertainty` constraints to give the tool more slack
- Validate final achieved frequency on hardware using XRT profiling APIs

### 5.5 Portability Across Alveo Cards

**Limitation**: This configuration is tightly coupled to the U50's specific HBM architecture (16 stacks, SLR layout).

**Porting Challenges**:
- **U200/U250**: These cards use DDR4 instead of HBM; the `HBM[n]` syntax in the cfg would need complete replacement with `DDR[n]` mappings
- **U280**: Has HBM but different stack count (8 stacks vs U50's 16) and different SLR organization; the range mappings (HBM[2:3], etc.) would need recalculation
- **Versal VCK190**: Completely different memory architecture (NoC-based instead of direct AXI-to-HBM); this cfg format is incompatible

**Porting Strategy**:
- For new cards, start from the card's vendor-provided connectivity example (e.g., `u200.cfg`, `u280.cfg`)
- Identify the equivalent memory resources (DDR banks on U200, HBM stacks on U280)
- Map the 8 AXI interfaces based on the new card's bandwidth topology:
  - U200: 4 DDR banks → gmem0-gmem3 to DDR[0:3], gmem4-gmem7 share or map to PLRAM
  - U280: 8 HBM stacks → each gmem maps to one HBM stack, or pairs use 2-stack interleaving
- Validate by comparing achieved bandwidth to theoretical peak; if <60% of peak, revisit mapping

**Recommendation**: Maintain separate `.cfg` files per card (`conn_u200.cfg`, `conn_u280.cfg`, etc.) rather than trying to create a universal config—card architectures are too different for one-size-fits-all connectivity.

---

## 6. Summary and Key Takeaways

### 6.1 What This Module Does

`conn_u50_cfg` is the **hardware traffic engineering blueprint** for the PageRank kernel on Alveo U50. It solves the memory bandwidth bottleneck by:
1. **Spreading load**: Mapping 8 AXI interfaces across 14 HBM stacks to parallelize memory access
2. **Enabling interleaving**: Using `HBM[a:b]` ranges to double bandwidth for high-volume data streams
3. **Localizing compute**: Fixing kernel placement in SLR0 near HBM controllers to minimize latency
4. **Simplifying orchestration**: Using single kernel instance to avoid multi-kernel synchronization overhead

### 6.2 Mental Model for Developers

Think of `conn_u50_cfg` as a **data center network topology design**:
- The 8 `m_axi_gmem*` interfaces are like top-of-rack switches in a server cluster
- The 16 HBM stacks are like backbone network links to storage arrays
- The `sp` directives are the fiber cables connecting specific switches to specific storage arrays
- The `slr` directive is the decision to place all compute in one data center hall (SLR0) rather than distributing across halls
- The `nk` directive is the choice to build one large warehouse-scale computer rather than a cluster of smaller servers

Just as a well-designed data center network minimizes latency and maximizes throughput by carefully placing compute near storage and avoiding oversubscribed links, `conn_u50_cfg` minimizes memory latency and maximizes bandwidth by carefully placing the kernel near HBM controllers and avoiding oversubscribed memory channels.

### 6.3 When to Modify This Configuration

**Modify when**:
- Porting to a different Alveo card (U200, U250, U280, etc.)—memory architecture changes require remapping
- Kernel HLS code changes add, remove, or rename `m_axi` interfaces—cfg must stay synchronized
- Profiling shows HBM bandwidth saturation on specific stacks—rebalance by changing `HBM[x:y]` mappings
- Timing closure fails on specific paths—try different SLR placement or HBM stack assignments

**Do NOT modify when**:
- Changing graph input datasets—data placement is controlled by Host code, not this cfg
- Tuning PageRank algorithm parameters (damping factor, convergence threshold)—these are runtime arguments
- Switching between different XRT versions—this cfg is hardware topology, not software API

### 6.4 Testing and Validation Checklist

Before declaring this configuration production-ready:

- [ ] **Syntax validation**: Run `v++ --link` with this cfg and verify no parse errors
- [ ] **Interface matching**: Verify all `m_axi_gmem*` names exactly match HLS pragmas in kernel source
- [ ] **Resource availability**: Confirm all HBM stacks referenced (0-13) exist and are user-accessible on target U50
- [ ] **Bandwidth benchmark**: Run microbenchmark writing/reading 1GB through each AXI interface; verify achieved bandwidth >60% of theoretical HBM stack bandwidth
- [ ] **Integration test**: Run full PageRank benchmark on representative graph (e.g., Twitter, Friendster); verify convergence and performance matches expected throughput
- [ ] **Timing closure**: Review post-route timing report; confirm worst negative slack (WNS) >0ps with reasonable margin (>500ps recommended)
- [ ] **Resource utilization**: Check LUT, FF, BRAM, URAM utilization in implementation report; ensure no resource overutilization that could cause placement failures

---

## 7. Related Documentation and Further Reading

- [pagerank_base_benchmark](graph-l2-benchmarks-pagerank-base-benchmark.md): Parent module containing this configuration; contains kernel source code and Host application details
- Xilinx U50 Data Sheet: Hardware specifications including HBM architecture, SLR layout, and power envelope
- Vitis User Guide (UG1393): Detailed documentation on connectivity configuration syntax, `sp`/`slr`/`nk` directives, and advanced options
- XRT Documentation: Host-side buffer allocation APIs, profiling tools for measuring actual HBM bandwidth
- HLS Pragma Reference (UG902): Documentation on `INTERFACE m_axi` pragmas and how they interact with connectivity configuration
