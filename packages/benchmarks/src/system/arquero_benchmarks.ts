import * as arrow from 'apache-arrow';
import * as aq from 'arquero';
import * as faker from 'faker';
import { SystemBenchmark, SystemBenchmarkMetadata, SystemBenchmarkContext, noop } from './system_benchmark';
import {
    generateArrow2Int32,
    generateArrowGroupedInt32,
    generateArrowInt32,
    generateArrowUtf8,
    generateArrowXInt32,
    generateCSVGroupedInt32,
    generateJSONGroupedInt32,
} from './data_generator';
import { getTPCHArrowTable } from './tpch_loader';

export class ArqueroTPCHBenchmark implements SystemBenchmark {
    tables: { [key: string]: aq.internal.Table } = {};
    scaleFactor: number;
    queryId: number;
    queryText: string | null;

    constructor(scaleFactor: number, queryId: number) {
        this.scaleFactor = scaleFactor;
        this.queryId = queryId;
        this.queryText = null;
    }
    getName(): string {
        return `arquero_tpch_${this.scaleFactor.toString().replace('.', '')}_q${this.queryId}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'tpch',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.scaleFactor, this.queryId],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        const lineitem = await getTPCHArrowTable(ctx.projectRootPath, this.scaleFactor, 'lineitem.arrow');
        const orders = await getTPCHArrowTable(ctx.projectRootPath, this.scaleFactor, 'orders.arrow');
        const customer = await getTPCHArrowTable(ctx.projectRootPath, this.scaleFactor, 'customer.arrow');
        const supplier = await getTPCHArrowTable(ctx.projectRootPath, this.scaleFactor, 'supplier.arrow');
        const region = await getTPCHArrowTable(ctx.projectRootPath, this.scaleFactor, 'region.arrow');
        const nation = await getTPCHArrowTable(ctx.projectRootPath, this.scaleFactor, 'nation.arrow');
        const partsupp = await getTPCHArrowTable(ctx.projectRootPath, this.scaleFactor, 'partsupp.arrow');
        const part = await getTPCHArrowTable(ctx.projectRootPath, this.scaleFactor, 'part.arrow');
        this.tables['lineitem'] = aq.fromArrow(lineitem);
        this.tables['orders'] = aq.fromArrow(orders);
        this.tables['customer'] = aq.fromArrow(customer);
        this.tables['supplier'] = aq.fromArrow(supplier);
        this.tables['region'] = aq.fromArrow(region);
        this.tables['nation'] = aq.fromArrow(nation);
        this.tables['partsupp'] = aq.fromArrow(partsupp);
        this.tables['part'] = aq.fromArrow(part);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        // XXX Check if explicit projection pushdown helps arquero here

        switch (this.queryId) {
            case 1: {
                const query = this.tables['lineitem']
                    .filter((d: any) => d.l_shipdate <= aq.op.timestamp('1998-09-02'))
                    .derive({
                        disc_price: (d: any) => d.l_extendedprice * (1 - d.l_discount),
                        charge: (d: any) => d.l_extendedprice * (1 - d.l_discount) * (1 + d.l_tax),
                    })
                    .groupby('l_returnflag', 'l_linestatus')
                    .rollup({
                        sum_qty: (d: any) => aq.op.sum(d.l_quantity),
                        sum_base_price: (d: any) => aq.op.sum(d.l_extendedprice),
                        sum_disc_price: (d: any) => aq.op.sum(d.disc_price),
                        sum_charge: (d: any) => aq.op.sum(d.charge),
                        avg_qty: (d: any) => aq.op.average(d.l_quantity),
                        avg_price: (d: any) => aq.op.average(d.l_extendedprice),
                        avg_disc: (d: any) => aq.op.average(d.l_discount),
                        count_order: (d: any) => aq.op.count(),
                    })
                    .orderby('l_returnflag', 'l_linestatus');
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 2: {
                const tmp = this.tables['region']
                    .filter((d: any) => d.op.equal(d.r_name, 'EUROPE'))
                    .join(this.tables['nation'], ['r_regionkey', 'n_regionkey'])
                    .join(this.tables['supplier'], ['n_nationkey', 's_nationkey']);
                const sub = tmp.join(this.tables['partsupp'], ['s_suppkey', 'ps_suppkey']);
                const sub2 = this.tables['part']
                    .filter((d: any) => d.p_size == 15 && aq.op.match(d.p_type, /.*BRASS$/g, 0) != null)
                    .join(sub, ['p_partkey', 'ps_partkey'])
                    .groupby('p_partkey')
                    .rollup({
                        min_ps_supplycost: (d: any) => aq.op.min(d.ps_supplycost),
                    })
                    .join(
                        this.tables['partsupp'],
                        (a: any, b: any) => a.p_partkey == b.ps_partkey && a.min_ps_supplycost == b.ps_supplycost,
                    );
                const query = tmp
                    .join(sub2, ['s_suppkey', 'ps_suppkey'])
                    .orderby(aq.desc('s_acctbal'), 'n_name', 's_name', 'p_partkey');
                for (const v of query.objects()) {
                    noop(v);
                }
                break;
            }
            case 3: {
                const c = this.tables['customer'].filter((d: any) => d.c_mktsegment == 'BUILDING');
                const o = this.tables['orders'].filter((d: any) => d.o_orderdate < aq.op.timestamp('1995-03-15'));
                const l = this.tables['lineitem'].filter((d: any) => d.l_shipdate < aq.op.timestamp('1995-03-15'));
                const query = c
                    .join(o, ['c_custkey', 'o_custkey'])
                    .join(l, ['o_orderkey', 'l_orderkey'])
                    .derive({
                        disc_price: (d: any) => d.l_extendedprice * (1 - d.l_discount),
                    })
                    .groupby('l_orderkey', 'o_orderdate', 'o_shippriority')
                    .rollup({
                        revenue: (d: any) => aq.op.sum(d.disc_price),
                    })
                    .orderby(aq.desc('revenue'), 'o_orderdate');
                for (const v of query.objects({ limit: 10, grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 4: {
                const o = this.tables['orders'].filter(
                    (d: any) =>
                        d.o_orderdate >= aq.op.timestamp('1993-07-01') && d.o_orderdate < aq.op.timestamp('1993-10-01'),
                );
                const l = this.tables['lineitem'].filter((d: any) => d.l_commitdate < d.l_receiptdate);
                const query = o
                    .join(l, ['o_orderkey', 'l_orderkey'])
                    .groupby('o_orderpriority')
                    .rollup({
                        order_count: aq.op.count(),
                    })
                    .orderby('o_orderpriority');
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 5: {
                const r = this.tables['region'].filter((d: any) => d.r_name == 'ASIA');
                const c = this.tables['customer'];
                const l = this.tables['lineitem'];
                const s = this.tables['supplier'];
                const o = this.tables['orders'].filter(
                    (d: any) =>
                        d.o_orderdate >= aq.op.timestamp('1994-01-01') && d.o_orderdate < aq.op.timestamp('1995-01-01'),
                );
                const n = this.tables['nation'];

                const right = r
                    .join(n, ['r_regionkey', 'n_regionkey'])
                    .join(c, ['n_nationkey', 'c_nationkey'])
                    .join(o, ['c_custkey', 'o_custkey'])
                    .join(l, ['o_orderkey', 'l_orderkey']);
                const query = s
                    .join(
                        right,
                        (a: any, b: any) =>
                            a.s_nationkey == b.n_nationkey &&
                            a.s_nationkey == b.c_nationkey &&
                            a.s_suppkey == b.l_suppkey,
                    )
                    .derive({
                        disc_price: (d: any) => d.l_extendedprice * (1 - d.l_discount),
                    })
                    .groupby('n_name')
                    .rollup({
                        revenue: (d: any) => aq.op.sum(d.disc_price),
                    })
                    .orderby(aq.desc('revenue'));
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 6: {
                const l = this.tables['lineitem'];
                const query = l
                    .filter(
                        (d: any) =>
                            d.l_quantity < 24 &&
                            d.l_discount >= 0.05 &&
                            d.l_discount <= 0.07 &&
                            d.l_shipdate >= aq.op.timestamp('1994-01-01') &&
                            d.l_shipdate < aq.op.timestamp('1995-01-01'),
                    )
                    .derive({
                        realprice: (d: any) => d.l_extendedprice * d.l_discount,
                    })
                    .rollup({
                        revenue: (d: any) => aq.op.sum(d.realprice),
                    });
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 7: {
                const s = this.tables['supplier'];
                const n1 = this.tables['nation'].rename({
                    n_nationkey: 'n1_nationkey',
                    n_name: 'n1_name',
                });
                const n2 = this.tables['nation'].rename({
                    n_nationkey: 'n2_nationkey',
                    n_name: 'n2_name',
                });
                const c = this.tables['customer'];
                const o = this.tables['orders'];
                const l = this.tables['lineitem']
                    .filter(
                        (d: any) =>
                            d.l_shipdate >= aq.op.timestamp('1995-01-01') &&
                            d.l_shipdate < aq.op.timestamp('1996-12-31'),
                    )
                    .derive({
                        l_year: (d: any) => aq.op.year(d.l_shipdate),
                        volume: (d: any) => d.l_extendedprice * (1 - d.l_discount),
                    });
                const nations = n1.join(
                    n2,
                    (a: any, b: any) =>
                        (a.n1_nationkey == 'FRANCE' && b.n2_nationkey == 'GERMANY') ||
                        (a.n1_nationkey == 'GERMANY' && b.n2_nationkey == 'FRANCE'),
                );
                const right = nations
                    .join(c, ['n2_nationkey', 'c_nationkey'])
                    .join(o, ['c_custkey', 'o_custkey'])
                    .join(l, ['o_orderkey', 'l_orderkey']);
                const query = s
                    .join(right, ['s_suppkey', 'l_suppkey'])
                    .groupby('n1_name', 'n2_name', 'l_year')
                    .rollup({
                        revenue: (d: any) => aq.op.sum(d.volume),
                    })
                    .orderby('n1_name', 'n2_name', 'l_year');
                for (const v of query.objects()) {
                    noop(v);
                }
                break;
            }
            case 8: {
                const p = this.tables['part'].filter((d: any) => d.p_type == 'ECONOMY ANODIZED STEEL');
                const o = this.tables['orders'].filter(
                    (d: any) =>
                        d.o_orderdate >= aq.op.timestamp('1995-01-01') &&
                        d.o_orderdate <= aq.op.timestamp('1996-12-31'),
                );
                const sub = p
                    .join(this.tables['lineitem'], ['p_partkey', 'l_partkey'])
                    .join(o, ['l_orderkey', 'o_orderkey'])
                    .join(this.tables['customer'], ['o_custkey', 'c_custkey']);
                const r2 = this.tables['region']
                    .filter((d: any) => d.r_name == 'AMERICA')
                    .rename({
                        r_regionkey: 'r2_regionkey',
                    });
                const n2 = this.tables['nation'].rename({
                    n_regionkey: 'n2_regionkey',
                    n_nationkey: 'n2_nationkey',
                    n_name: 'n2_name',
                });
                const sub2 = r2
                    .join(n2, ['r2_regionkey', 'n2_regionkey'])
                    .join(sub, ['n2_nationkey', 'c_nationkey'])
                    .join(this.tables['supplier'], ['l_suppkey', 's_suppkey']);
                const query = this.tables['nation']
                    .join(sub2, ['n_nationkey', 's_nationkey'])
                    .derive({
                        o_year: (d: any) => aq.op.year(d.o_orderdate),
                        volume: (d: any) => d.l_extendedprice * (1 - d.l_discount),
                    })
                    .groupby('o_year')
                    .rollup({
                        mkt_share: (d: any) => aq.op.sum(d.n2_name == 'BRAZIL' ? d.volume : 0) / aq.op.sum(d.volume),
                    })
                    .orderby('o_year')
                    .select('o_year', 'mkt_share');
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 9: {
                const sub = this.tables['nation'].join(this.tables['supplier'], ['n_nationkey', 's_nationkey']);
                const query = this.tables['part']
                    .filter((d: any) => aq.op.match(d.p_name, /.*green.*/g, 0) != null)
                    .join(this.tables['partsupp'], ['p_partkey', 'ps_partkey'])
                    .join(sub, ['ps_suppkey', 's_suppkey'])
                    .join(
                        this.tables['lineitem'],
                        (a: any, b: any) => a.p_partkey == b.l_partkey && a.s_suppkey == b.l_suppkey,
                    )
                    .join(this.tables['orders'], ['l_orderkey', 'o_orderkey'])
                    .derive({
                        o_year: (d: any) => aq.op.year(d.o_orderdate),
                        amount: (d: any) => d.l_extendedprice * (1 - d.l_discount) - d.ps_supplycost * d.l_quantity,
                    })
                    .groupby('n_name', 'o_year')
                    .rollup({
                        sum_profit: (d: any) => aq.op.sum(d.amount),
                    })
                    .orderby('n_name', aq.desc('o_year'));
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 10: {
                const query = this.tables['orders']
                    .filter(
                        (d: any) =>
                            d.o_orderdate >= aq.op.timestamp('1993-01-01') &&
                            d.o_orderdate <= aq.op.timestamp('1993-12-31'),
                    )
                    .join(
                        this.tables['lineitem'].filter((d: any) => d.l_returnflag == 'R'),
                        ['o_orderkey', 'l_orderkey'],
                    )
                    .join(this.tables['customer'], ['o_custkey', 'c_custkey'])
                    .join(this.tables['nation'], ['c_nationkey', 'n_nationkey'])
                    .derive({
                        realprice: (d: any) => d.l_extendedprice * (1 - d.l_discount),
                    })
                    .groupby('c_custkey')
                    .rollup({
                        revenue: (d: any) => aq.op.sum(d.realprice),
                    })
                    .orderby(aq.desc('revenue'));
                for (const v of query.objects({ grouped: true, limit: 20 })) {
                    noop(v);
                }
                break;
            }
            case 11: {
                const temp = this.tables['nation']
                    .filter((d: any) => d.n_name == 'GERMANY')
                    .join(this.tables['supplier'], ['n_nationkey', 's_nationkey'])
                    .join(this.tables['partsupp'], ['s_suppkey', 'ps_suppkey'])
                    .derive({
                        value: (d: any) => d.ps_supplycost * d.ps_availqty,
                    });
                const total = temp.rollup({
                    threshold: (d: any) => 0.0001 * aq.op.sum(d.value),
                });
                const query = temp
                    .groupby('ps_partkey')
                    .rollup({
                        value_sum: (d: any) => aq.op.sum(d.value),
                    })
                    .join(total, (a: any, b: any) => a.value_sum > b.threshold)
                    .orderby(aq.desc('value_sum'));
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 12: {
                const query = this.tables['lineitem']
                    .filter(
                        (d: any) =>
                            (d.l_shipmode == 'MAIL' || d.l_shipmode == 'SHIP') &&
                            d.l_commitdate < d.l_receiptdate &&
                            d.l_shipdate < d.l_commitdate &&
                            d.l_receiptdate >= aq.op.timestamp('1994-01-01') &&
                            d.l_receiptdate <= aq.op.timestamp('1994-12-31'),
                    )
                    .join(this.tables['orders'], ['l_orderkey', 'o_orderkey'])
                    .derive({
                        high_line: (d: any) =>
                            d.o_orderpriority == '1-URGENT' || d.o_orderpriority == '2-HIGH' ? 1 : 0,
                        low_line: (d: any) =>
                            d.o_orderpriority != '1-URGENT' && d.o_orderpriority != '2-HIGH' ? 1 : 0,
                    })
                    .groupby('l_shipmode')
                    .rollup({
                        high_line: (d: any) => aq.op.sum(d.high_line),
                        low_line: (d: any) => aq.op.sum(d.low_line),
                    })
                    .orderby('l_shipmode');
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 13: {
                const o = this.tables['orders'].filter(
                    (d: any) => aq.op.match(d.o_comment, /^.*special.*requests.*$/g, 0) == null,
                );
                const query = this.tables['customer']
                    .join_left(o, ['c_custkey', 'o_custkey'])
                    .derive({
                        o_orderkey_not_null: (d: any) => (d.o_orderkey != null ? 1 : 0),
                    })
                    .groupby('c_custkey')
                    .rollup({
                        c_count: (d: any) => aq.op.sum(d.o_orderkey_not_null),
                    })
                    .groupby('c_count')
                    .rollup({
                        custdist: (d: any) => aq.op.count(),
                    })
                    .orderby(aq.desc('custdist'), aq.desc('c_count'));
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 14: {
                const query = this.tables['lineitem']
                    .filter(
                        (d: any) =>
                            d.l_receiptdate >= aq.op.timestamp('1995-09-01') &&
                            d.l_receiptdate <= aq.op.timestamp('1995-09-30'),
                    )
                    .join(this.tables['part'], ['l_partkey', 'p_partkey'])
                    .derive({
                        realprice: (d: any) => d.l_extendedprice * (1 - d.l_discount),
                        promoprice: (d: any) =>
                            aq.op.match(d.p_type, /^PROMO.*/g, 0) != null ? d.l_extendedprice * (1 - d.l_discount) : 0,
                    })
                    .rollup({
                        sum_total: (d: any) => aq.op.sum(d.realprice),
                        sum_promo: (d: any) => aq.op.sum(d.promoprice),
                    })
                    .derive({
                        rel_promo: (d: any) => (d.sum_total == 0 ? 0 : (100 * d.sum_promo) / d.sum_total),
                    });
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 15: {
                const temp = this.tables['lineitem']
                    .filter(
                        (d: any) =>
                            d.l_receiptdate >= aq.op.timestamp('1996-01-01') &&
                            d.l_receiptdate <= aq.op.timestamp('1996-03-31'),
                    )
                    .derive({
                        realprice: (d: any) => d.l_extendedprice * (1 - d.l_discount),
                    })
                    .groupby('l_suppkey')
                    .rollup({
                        revenue: (d: any) => aq.op.sum(d.realprice),
                    });
                const query = temp
                    .rollup({
                        total_revenue: (d: any) => aq.op.max(d.revenue),
                    })
                    .join(temp, (a: any, b: any) => aq.op.equal(a.total_revenue, b.revenue))
                    .join(this.tables['supplier'], ['l_suppkey', 's_suppkey'])
                    .orderby('s_suppkey');
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 16: {
                const supplier = this.tables['supplier'].filter(
                    (d: any) => d.match(d.s_comment, /^.*Customer.*Complaints.*$/, 0) != null,
                );
                const query = this.tables['part']
                    .filter(
                        (d: any) =>
                            d.p_brand != 'Brand#45' &&
                            aq.op.match(d.p_type, /^MEDIUM POLISHED.*$/, 0) == null &&
                            (d.p_size == 49 ||
                                d.p_size == 14 ||
                                d.p_size == 19 ||
                                d.p_size == 23 ||
                                d.p_size == 36 ||
                                d.p_size == 45 ||
                                d.p_size == 19),
                    )
                    .join(this.tables['partsupp'], ['p_partkey', 'ps_partkey'])
                    .antijoin(supplier, ['ps_partkey', 's_suppkey'])
                    .groupby('p_brand', 'p_type', 'p_size')
                    .rollup({
                        supplier_cnt: aq.op.distinct('ps_suppkey'),
                    })
                    .orderby(aq.desc('supplier_cnt'), 'p_brand', 'p_type', 'p_size');
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 17: {
                const tmp = this.tables['part']
                    .filter((d: any) => d.p_brand == 'Brand#23' && d.p_container == 'MED BOX')
                    .join(this.tables['lineitem'], ['p_partkey', 'l_partkey']);
                const agg = tmp.groupby('p_partkey').rollup({
                    avg_qty: aq.op.mean('l_quantity'),
                });
                const query = tmp
                    .join(agg, (a: any, b: any) => a.p_partkey == b.p_partkey && a.l_quantity < 0.2 * b.avg_qty)
                    .rollup({
                        avg_yearly: (d: any) => aq.op.sum(d.l_extendedprice) / 7.0,
                    });
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 18: {
                const query = this.tables['lineitem']
                    .groupby('l_orderkey')
                    .rollup({
                        quantity: aq.op.sum('l_quantity'),
                    })
                    .filter((d: any) => d.quantity > 300)
                    .join(this.tables['orders'], ['l_orderkey', 'o_orderkey'])
                    .join(this.tables['customer'], ['o_custkey', 'c_custkey'])
                    .join(this.tables['lineitem'], ['o_orderkey', 'l_orderkey'])
                    .groupby('c_name', 'c_custkey', 'o_orderkey', 'o_orderdate', 'o_totalprice')
                    .rollup({
                        quantity: aq.op.sum('l_quantity'),
                    })
                    .orderby(aq.desc('o_totalprice'), 'o_orderdate');
                for (const v of query.objects({ grouped: true, limit: 100 })) {
                    noop(v);
                }
                break;
            }
            case 19: {
                const part = this.tables['part'].filter(
                    (d: any) =>
                        (d.p_size >= 1 &&
                            d.p_size <= 5 &&
                            d.p_brand == 'Brand#12' &&
                            (d.p_container == 'SM BOX' || d.p_container == 'SM CASE' || d.p_container == 'SM PKG')) ||
                        (d.p_size >= 1 &&
                            d.p_size <= 10 &&
                            d.p_brand == 'Brand#32' &&
                            (d.p_container == 'MED BOX' ||
                                d.p_container == 'MED CASE' ||
                                d.p_container == 'MED PKG')) ||
                        (d.p_size >= 1 &&
                            d.p_size <= 15 &&
                            d.p_brand == 'Brand#34' &&
                            (d.p_container == 'LG BOX' || d.p_container == 'LG CASE' || d.p_container == 'LG PKG')),
                );
                const lineitem = this.tables['lineitem'].filter(
                    (d: any) =>
                        d.l_shipinstruct == 'DELIVER IN PERSON' &&
                        (d.l_shipmode == 'AIR' || d.l_shipmode == 'AIR REG') &&
                        d.l_quantity >= 1 &&
                        d.l_quantity <= 30,
                );
                const query = part
                    .join(
                        lineitem,
                        (a: any, b: any) =>
                            (a.p_size >= 1 &&
                                a.p_size <= 5 &&
                                a.p_brand == 'Brand#12' &&
                                (a.p_container == 'SM BOX' ||
                                    a.p_container == 'SM CASE' ||
                                    a.p_container == 'SM PKG') &&
                                b.l_quantity >= 1 &&
                                b.l_quantity <= 11) ||
                            (a.p_size >= 1 &&
                                a.p_size <= 10 &&
                                a.p_brand == 'Brand#32' &&
                                (a.p_container == 'MED BOX' ||
                                    a.p_container == 'MED CASE' ||
                                    a.p_container == 'MED PKG') &&
                                b.l_quantity >= 10 &&
                                b.l_quantity <= 20) ||
                            (a.p_size >= 1 &&
                                a.p_size <= 15 &&
                                a.p_brand == 'Brand#34' &&
                                (a.p_container == 'LG BOX' ||
                                    a.p_container == 'LG CASE' ||
                                    a.p_container == 'LG PKG') &&
                                b.l_quantity >= 20 &&
                                b.l_quantity <= 30),
                    )
                    .derive({
                        realprice: (d: any) => d.l_extendedprice * (1 - d.l_discount),
                    })
                    .rollup({
                        revenue: aq.op.sum('realprice'),
                    });
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 20: {
                const qty = this.tables['lineitem']
                    .filter(
                        (d: any) =>
                            d.l_shipdate >= aq.op.timestamp('1994-01-01') &&
                            d.l_shipdate < aq.op.timestamp('1995-01-01'),
                    )
                    .groupby('l_partkey', 'l_suppkey')
                    .rollup({
                        quantity: aq.op.sum('l_quantity'),
                    });
                const sub = this.tables['part']
                    .filter((d: any) => aq.op.match(d.p_name, /^forest.*$/, 0) != null)
                    .join(this.tables['partsupp'], ['p_partkey', 'ps_partkey'])
                    .join(
                        qty,
                        (a: any, b: any) =>
                            a.ps_partkey == b.l_partkey &&
                            a.ps_suppkey == b.l_suppkey &&
                            a.ps_availqty > 0.5 * b.quantity,
                    );
                const query = this.tables['nation']
                    .filter((d: any) => d.n_name == 'CANADA')
                    .join(this.tables['supplier'], ['n_nationkey', 's_nationkey'])
                    .semijoin(sub, ['s_suppkey', 'ps_suppkey'])
                    .orderby('s_name');
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            case 21: {
                const lineitem = this.tables['lineitem'].filter((d: any) => d.l_receiptdate > d.l_commitdate);
                const orders = this.tables['orders'].filter((d: any) => d.o_orderstatus == 'F');
                const query = this.tables['nation']
                    .filter((d: any) => d.n_name == 'SAUDI ARABIA')
                    .join(this.tables['supplier'], ['n_nationkey', 's_nationkey'])
                    .join(lineitem, ['s_suppkey', 'l_suppkey'])
                    .join(orders, ['l_orderkey', 'o_orderkey'])
                    .antijoin(lineitem, (a: any, b: any) => a.l_suppkey != b.l_suppkey && a.l_orderkey == b.l_orderkey)
                    .semijoin(
                        this.tables['lineitem'],
                        (a: any, b: any) => a.l_suppkey != b.l_suppkey && a.l_orderkey == b.l_orderkey,
                    )
                    .groupby('s_name')
                    .rollup({
                        numwait: aq.op.count(),
                    })
                    .orderby(aq.desc('numwait'), 's_name');
                for (const v of query.objects({ grouped: true, limit: 100 })) {
                    noop(v);
                }
                break;
            }
            case 22: {
                const customers = this.tables['customer'].filter(
                    (d: any) =>
                        d.c_acctbal > 0.0 &&
                        aq.op.match(d.c_phone, /^((13)|(31)|(23)|(29)|(30)|(18)|(17))/g, 0) != null,
                );
                const total_avg = customers.rollup({
                    avg_c_acctbal: aq.op.mean('c_acctbal'),
                });
                const query = customers
                    .join(total_avg, (a: any, b: any) => a.c_acctbal > b.avg_c_acctbal)
                    .antijoin(this.tables['orders'], ['c_custkey', 'o_custkey'])
                    .derive({
                        cntrycode: (d: any) => aq.op.substring(d.c_phone, 0, 2),
                    })
                    .groupby('cntrycode')
                    .rollup({
                        numcust: aq.op.count(),
                        totacctbal: aq.op.sum('c_acctbal'),
                    })
                    .orderby('cntrycode');
                for (const v of query.objects({ grouped: true })) {
                    noop(v);
                }
                break;
            }
            default:
                throw new Error(`TPC-H query ${this.queryId} is not supported`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables['lineitem'];
    }
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables['lineitem'];
    }
}

export class ArqueroIntegerScanBenchmark implements SystemBenchmark {
    tuples: number;
    tables: { [key: string]: aq.internal.Table } = {};

    constructor(tuples: number) {
        this.tuples = tuples;
    }
    getName(): string {
        return `arquero_integer_scan_${this.tuples}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'integer_scan',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuples],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        const [schema, batches] = generateArrowInt32(this.tuples);
        const table = new arrow.Table(schema, batches);
        this.tables[this.getName()] = aq.fromArrow(table);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        let n = 0;
        for (const v of this.tables[this.getName()].array('v0')) {
            noop(v);
            n += 1;
        }
        if (n !== this.tuples) {
            throw Error(`invalid tuple count. expected ${this.tuples}, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
}

export class ArqueroIntegerSumBenchmark implements SystemBenchmark {
    tuples: number;
    groupSize: number;
    tables: { [key: string]: aq.internal.Table } = {};

    constructor(tuples: number, groupSize: number) {
        this.tuples = tuples;
        this.groupSize = groupSize;
    }
    getName(): string {
        return `arquero_integer_sum_${this.tuples}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'integer_sum',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuples, this.groupSize],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        const [schema, batches] = generateArrowGroupedInt32(this.tuples, this.groupSize);
        const table = new arrow.Table(schema, batches);
        this.tables[this.getName()] = aq.fromArrow(table);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        let n = 0;
        for (const v of this.tables[this.getName()]
            .groupby('v0')
            .rollup({ sum: (d: any) => aq.op.sum(d.v1) })
            .array('sum')) {
            noop(v);
            n += 1;
        }
        const expectedGroups = this.tuples / this.groupSize;
        if (n !== expectedGroups) {
            throw Error(`invalid tuple count. expected ${expectedGroups}, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
}

export class ArqueroIntegerSortBenchmark implements SystemBenchmark {
    tuples: number;
    columnCount: number;
    orderBy: string[];
    tables: { [key: string]: aq.internal.Table } = {};

    constructor(tuples: number, columnCount: number, orderCriteria: number) {
        this.tuples = tuples;
        this.columnCount = columnCount;
        this.orderBy = [];
        for (let i = 0; i < orderCriteria; ++i) {
            this.orderBy.push(`v${i}`);
        }
    }
    getName(): string {
        return `arquero_integer_sort_${this.tuples}_${this.columnCount}_${this.orderBy.length}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'integer_sort',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuples, this.columnCount, this.orderBy.length],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        const [schema, batches] = generateArrowXInt32(this.tuples, this.columnCount);
        const table = new arrow.Table(schema, batches);
        this.tables[this.getName()] = aq.fromArrow(table);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        let n = 0;
        for (const v of this.tables[this.getName()].orderby(this.orderBy).array('v0')) {
            noop(v);
            n += 1;
        }
        if (n !== this.tuples) {
            throw Error(`invalid tuple count. expected ${this.tuples}, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
}

export class ArqueroIntegerTopKBenchmark implements SystemBenchmark {
    tuples: number;
    columnCount: number;
    orderBy: string[];
    k: number;
    tables: { [key: string]: aq.internal.Table } = {};

    constructor(tuples: number, columnCount: number, orderCriteria: number, k: number) {
        this.tuples = tuples;
        this.columnCount = columnCount;
        this.orderBy = [];
        this.k = k;
        for (let i = 0; i < orderCriteria; ++i) {
            this.orderBy.push(`v${i}`);
        }
    }
    getName(): string {
        return `arquero_integer_topk_${this.tuples}_${this.columnCount}_${this.orderBy.length}_${this.k}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'integer_topk',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuples, this.columnCount, this.orderBy.length, this.k],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        const [schema, batches] = generateArrowXInt32(this.tuples, this.columnCount);
        const table = new arrow.Table(schema, batches);
        this.tables[this.getName()] = aq.fromArrow(table);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        let n = 0;
        for (const v of this.tables[this.getName()].orderby(this.orderBy).objects({ limit: this.k })) {
            noop(v);
            n += 1;
        }
        if (n !== this.k) {
            throw Error(`invalid tuple count. expected ${this.k}, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
}

export class ArqueroCSVSumBenchmark implements SystemBenchmark {
    tuples: number;
    groupSize: number;
    csvBuffer: string | null;

    constructor(tuples: number, groupSize: number) {
        this.tuples = tuples;
        this.groupSize = groupSize;
        this.csvBuffer = null;
    }
    getName(): string {
        return `arquero_csv_sum_${this.tuples}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'csv_sum',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuples, this.groupSize],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        this.csvBuffer = generateCSVGroupedInt32(this.tuples, this.groupSize);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        const table = aq.fromCSV(this.csvBuffer!, {
            header: false,
            names: ['v0', 'v1'],
            delimiter: '|',
        });
        let n = 0;
        for (const v of table
            .groupby('v0')
            .rollup({ sum: (d: any) => aq.op.sum(d.v1) })
            .array('sum')) {
            noop(v);
            n += 1;
        }
        const expectedGroups = this.tuples / this.groupSize;
        if (n !== expectedGroups) {
            throw Error(`invalid tuple count. expected ${expectedGroups}, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {}
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {}
}

export class ArqueroJSONSumBenchmark implements SystemBenchmark {
    tuples: number;
    groupSize: number;
    jsonBuffer: string | null;

    constructor(tuples: number, groupSize: number) {
        this.tuples = tuples;
        this.groupSize = groupSize;
        this.jsonBuffer = null;
    }
    getName(): string {
        return `arquero_json_sum_${this.tuples}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'json_sum',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuples, this.groupSize],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        this.jsonBuffer = generateJSONGroupedInt32(this.tuples, this.groupSize);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        const table = aq.fromJSON(this.jsonBuffer!);
        let n = 0;
        for (const v of table
            .groupby('v0')
            .rollup({ sum: (d: any) => aq.op.sum(d.v1) })
            .array('sum')) {
            noop(v);
            n += 1;
        }
        const expectedGroups = this.tuples / this.groupSize;
        if (n !== expectedGroups) {
            throw Error(`invalid tuple count. expected ${expectedGroups}, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {}
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {}
}

export class ArqueroIntegerJoin2Benchmark implements SystemBenchmark {
    tuplesA: number;
    tuplesB: number;
    filterA: number;
    stepAB: number;
    tables: { [key: string]: aq.internal.Table } = {};

    constructor(a: number, b: number, filterA: number, stepAB: number) {
        this.tuplesA = a;
        this.tuplesB = b;
        this.filterA = filterA;
        this.stepAB = stepAB;
    }
    getName(): string {
        return `arquero_integer_join2_${this.tuplesA}_${this.tuplesB}_${this.filterA}_${this.stepAB}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'integer_join2',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuplesA, this.tuplesB, this.stepAB, this.filterA],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        const [schemaA, batchesA] = generateArrowInt32(this.tuplesA);
        const [schemaB, batchesB] = generateArrow2Int32(this.tuplesB, this.stepAB);
        const tableA = new arrow.Table(schemaA, batchesA);
        const tableB = new arrow.Table(schemaB, batchesB);
        this.tables['A'] = aq.fromArrow(tableA);
        this.tables['B'] = aq.fromArrow(tableB);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        const filter = this.filterA;
        const result = this.tables['A']
            .params({ filter })
            .filter((row: any) => row.v0 < filter)
            .rename({ v0: 'a0' })
            .join(this.tables['B'].rename({ v0: 'b0', v1: 'b1' }), ['a0', 'b1']);
        let n = 0;
        for (const v of result) {
            noop(v);
            n += 1;
        }
        const expected = this.filterA * this.stepAB;
        if (n !== expected) {
            throw Error(`invalid tuple count. expected ${expected}, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables['A'];
        delete this.tables['B'];
    }
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables['A'];
        delete this.tables['B'];
    }
}

export class ArqueroIntegerJoin3Benchmark implements SystemBenchmark {
    tuplesA: number;
    tuplesB: number;
    tuplesC: number;
    stepAB: number;
    stepBC: number;
    filterA: number;
    tables: { [key: string]: aq.internal.Table } = {};

    constructor(a: number, b: number, c: number, filterA: number, stepAB: number, stepBC: number) {
        this.tuplesA = a;
        this.tuplesB = b;
        this.tuplesC = c;
        this.stepAB = stepAB;
        this.stepBC = stepBC;
        this.filterA = filterA;
    }
    getName(): string {
        return `arquero_integer_join3_${this.tuplesA}_${this.tuplesB}_${this.tuplesC}_${this.filterA}_${this.stepAB}_${this.stepBC}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'integer_join3',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuplesA, this.tuplesB, this.tuplesC, this.stepAB, this.stepBC, this.filterA],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        const [schemaA, batchesA] = generateArrowInt32(this.tuplesA);
        const [schemaB, batchesB] = generateArrow2Int32(this.tuplesB, this.stepAB);
        const [schemaC, batchesC] = generateArrow2Int32(this.tuplesC, this.stepBC);
        const tableA = new arrow.Table(schemaA, batchesA);
        const tableB = new arrow.Table(schemaB, batchesB);
        const tableC = new arrow.Table(schemaC, batchesC);
        this.tables['A'] = aq.fromArrow(tableA);
        this.tables['B'] = aq.fromArrow(tableB);
        this.tables['C'] = aq.fromArrow(tableC);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        const filter = this.filterA;
        const result = this.tables['A']
            .params({ filter })
            .filter((row: any) => row.v0 < filter)
            .rename({ v0: 'a0' })
            .join(this.tables['B'].rename({ v0: 'b0', v1: 'b1' }), ['a0', 'b1'])
            .join(this.tables['C'].rename({ v0: 'c0', v1: 'c1' }), ['b0', 'c1']);
        let n = 0;
        for (const v of result) {
            noop(v);
            n += 1;
        }
        const expected = this.filterA * this.stepAB * this.stepBC;
        if (n !== expected) {
            throw Error(`invalid tuple count. expected ${expected}, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables['A'];
        delete this.tables['B'];
        delete this.tables['C'];
    }
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables['A'];
        delete this.tables['B'];
        delete this.tables['C'];
    }
}

export class ArqueroVarcharScanBenchmark implements SystemBenchmark {
    tuples: number;
    tables: { [key: string]: aq.internal.Table } = {};
    chars: number;

    constructor(tuples: number, chars: number) {
        this.tuples = tuples;
        this.chars = chars;
    }
    getName(): string {
        return `arquero_varchar_scan_${this.tuples}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'varchar_scan',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuples, this.chars],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        const [schema, batches] = generateArrowUtf8(this.tuples, this.chars);
        const table = new arrow.Table(schema, batches);
        this.tables[this.getName()] = aq.fromArrow(table);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        let n = 0;
        for (const v of this.tables[this.getName()].array('v0')) {
            noop(v);
            n += 1;
        }
        if (n !== this.tuples) {
            throw Error(`invalid tuple count. expected ${this.tuples}, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
}

export class ArqueroRegexBenchmark implements SystemBenchmark {
    tuples: number;
    tables: { [key: string]: aq.internal.Table } = {};
    chars: number;

    constructor(tuples: number, chars: number) {
        this.tuples = tuples;
        this.chars = chars;
    }
    getName(): string {
        return `arquero_regex_${this.tuples}`;
    }
    getMetadata(): SystemBenchmarkMetadata {
        return {
            benchmark: 'regex',
            system: 'arquero',
            tags: [],
            timestamp: +new Date(),
            parameters: [this.tuples, this.chars],
        };
    }
    async beforeAll(ctx: SystemBenchmarkContext): Promise<void> {
        faker.seed(ctx.seed);
        const [schema, batches] = generateArrowUtf8(this.tuples, this.chars);
        const table = new arrow.Table(schema, batches);
        this.tables[this.getName()] = aq.fromArrow(table);
    }
    async beforeEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async run(_ctx: SystemBenchmarkContext): Promise<void> {
        let n = 0;
        for (const v of this.tables[this.getName()].filter((d: any) => aq.op.match(d.v0, /^.#+$/g, null)).array('v0')) {
            noop(v);
            n += 1;
        }
        if (n !== 10) {
            throw Error(`invalid tuple count. expected 10, received ${n}`);
        }
    }
    async afterEach(_ctx: SystemBenchmarkContext): Promise<void> {}
    async afterAll(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
    async onError(_ctx: SystemBenchmarkContext): Promise<void> {
        delete this.tables[this.getName()];
    }
}
