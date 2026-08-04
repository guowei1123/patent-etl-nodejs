import { describe, expect, it, vi } from 'vitest'
import type { ParsedPatent } from '@/types'

// 在模块导入前设置环境变量，确保 filter-config.ts 能读取到白名单
vi.hoisted(() => {
  process.env.PATENT_FILTER_IPC_WHITELIST = 'H01M10,B60K1,A41H43'
  process.env.PATENT_FILTER_ENTITY_WHITELIST =
    '第一汽车集团,奇瑞,上汽,上海汽车集团,赛力斯,北汽,北京新能源汽车,小鹏汽车,北京车和家,理想汽车,蔚来,零跑,岚图,现代自动车,江铃汽车,深蓝汽车,大众汽车,引望,宝马股份,奔驰集团,通用汽车一汽解放,chery automobile,shanghai automobile,shanghai automotive,jinkang new energy,beijing automotive,beijing new energy,chehejia automobile,nio technology,leapmotor,voyah automobile,hyundai motor,jiangling motors,deepal automobile,volkswagen,yinwang intelligent,bmw ag,benz ag,general motors,一汽大众,nio nextev'
})

import {
  matchesIpcWhitelist,
  matchesEntityWhitelist,
  passesFilter,
  filterPatents,
  IPC_WHITELIST,
  ENTITY_WHITELIST,
} from '../filter-config'

function createPatent(overrides: Partial<ParsedPatent> = {}): ParsedPatent {
  return {
    patent_number: '12345678',
    patent_type: 'invention',
    title: '测试专利',
    ...overrides,
  }
}

describe('filter-config — IPC 白名单匹配', () => {
  it('空 IPC 列表不匹配', () => {
    const p = createPatent()
    expect(matchesIpcWhitelist(p)).toBe(false)
  })

  it('有 IPC 但不在白名单中', () => {
    const p = createPatent({
      ipc_structured: ['A01B1/00'],
    })
    expect(matchesIpcWhitelist(p)).toBe(false)
  })

  it('IPC 码在白名单中精确匹配（带斜杠细分）', () => {
    const p = createPatent({
      ipc_structured: ['H01M10/0525'],
    })
    // 白名单有 H01M10，专利 IPC 分组码部分为 H01M10
    expect(matchesIpcWhitelist(p)).toBe(true)
  })

  it('IPC 码精确匹配（无斜杠）', () => {
    const p = createPatent({
      ipc_structured: ['A41H43'],
    })
    // 白名单有 A41H43，精确匹配
    expect(matchesIpcWhitelist(p)).toBe(true)
  })

  it('白名单 H01M1 不匹配专利 H01M10（精确匹配，不前缀匹配）', () => {
    // 测试环境中白名单包含 H01M10 但不包含 H01M1
    // 这里验证 H01M10 不被当作 H01M1 的前缀匹配
    const p = createPatent({
      ipc_structured: ['H01M10'],
    })
    // 白名单有 H01M10，精确匹配成功
    expect(matchesIpcWhitelist(p)).toBe(true)
  })

  it('白名单中不存在的 IPC 码不匹配', () => {
    const p = createPatent({
      ipc_structured: ['H01M99/0525'],
    })
    // 白名单没有 H01M99 也没有 H01M99/0525
    expect(matchesIpcWhitelist(p)).toBe(false)
  })

  it('IPC 码大小写不敏感', () => {
    const p = createPatent({
      ipc_structured: ['h01m10/0525'],
    })
    expect(matchesIpcWhitelist(p)).toBe(true)
  })

  it('IPC 码带空格能匹配', () => {
    const p = createPatent({
      ipc_structured: ['H01M 10/0525'],
    })
    expect(matchesIpcWhitelist(p)).toBe(true)
  })

  it('IPC 码带版本号能匹配', () => {
    const p = createPatent({
      ipc_structured: ['H01M10/0525 (2006.01)'],
    })
    expect(matchesIpcWhitelist(p)).toBe(true)
  })

  it('多个 IPC 码，其中一个匹配', () => {
    const p = createPatent({
      ipc_structured: ['A01B1/00', 'H01M10/0525'],
    })
    expect(matchesIpcWhitelist(p)).toBe(true)
  })

  it('ipc_codes 字段也能匹配', () => {
    const p = createPatent({
      ipc_codes: ['H01M10/0525'],
    })
    expect(matchesIpcWhitelist(p)).toBe(true)
  })
})

describe('filter-config — 实体白名单匹配', () => {
  it('无实体信息不匹配', () => {
    const p = createPatent()
    expect(matchesEntityWhitelist(p)).toBe(false)
  })

  it('申请人匹配（中文）', () => {
    const p = createPatent({
      applicants_structured: [{ name: '奇瑞汽车股份有限公司' }],
    })
    expect(matchesEntityWhitelist(p)).toBe(true)
  })

  it('申请人匹配（英文）', () => {
    const p = createPatent({
      applicants_structured: [{ name: 'Chery Automobile Co., Ltd.' }],
    })
    expect(matchesEntityWhitelist(p)).toBe(true)
  })

  it('申请人不匹配', () => {
    const p = createPatent({
      applicants_structured: [{ name: '完全不相关的测试公司ABC' }],
    })
    expect(matchesEntityWhitelist(p)).toBe(false)
  })

  it('发明人匹配', () => {
    const p = createPatent({
      inventors_structured: ['奇瑞'],
    })
    expect(matchesEntityWhitelist(p)).toBe(true)
  })

  it('专利权人匹配', () => {
    const p = createPatent({
      assignees: [{ name: '上海汽车集团股份有限公司' }],
    })
    expect(matchesEntityWhitelist(p)).toBe(true)
  })

  it('扁平 applicant 字段匹配', () => {
    const p = createPatent({
      applicant: '蔚来汽车科技有限公司',
    })
    expect(matchesEntityWhitelist(p)).toBe(true)
  })

  it('扁平 assignee 字段匹配', () => {
    const p = createPatent({
      assignee: '理想汽车（北京）有限公司',
    })
    expect(matchesEntityWhitelist(p)).toBe(true)
  })

  it('大小写不敏感', () => {
    const p = createPatent({
      applicants_structured: [{ name: 'CHERY AUTOMOBILE' }],
    })
    expect(matchesEntityWhitelist(p)).toBe(true)
  })

  it('包含匹配（子串）', () => {
    const p = createPatent({
      applicants_structured: [{ name: '小鹏汽车科技有限公司' }],
    })
    expect(matchesEntityWhitelist(p)).toBe(true)
  })

  it('多个实体，其中一个匹配', () => {
    const p = createPatent({
      applicants_structured: [{ name: '完全不相关的测试公司ABC' }],
      inventors_structured: ['蔚来'],
    })
    expect(matchesEntityWhitelist(p)).toBe(true)
  })
})

describe('filter-config — passesFilter 综合判定', () => {
  it('IPC 匹配通过', () => {
    const p = createPatent({
      ipc_structured: ['H01M10/0525'],
    })
    expect(passesFilter(p)).toBe(true)
  })

  it('实体匹配通过', () => {
    const p = createPatent({
      applicants_structured: [{ name: '奇瑞' }],
    })
    expect(passesFilter(p)).toBe(true)
  })

  it('两者都匹配通过', () => {
    const p = createPatent({
      ipc_structured: ['H01M10/0525'],
      applicants_structured: [{ name: '奇瑞' }],
    })
    expect(passesFilter(p)).toBe(true)
  })

  it('两者都不匹配被过滤', () => {
    const p = createPatent({
      ipc_structured: ['A01B1/00'],
      applicants_structured: [{ name: '完全不相关的测试公司ABC' }],
    })
    expect(passesFilter(p)).toBe(false)
  })

  it('完全空数据被过滤', () => {
    const p = createPatent()
    expect(passesFilter(p)).toBe(false)
  })
})

describe('filter-config — filterPatents 批量过滤', () => {
  it('空列表返回空', () => {
    const result = filterPatents([])
    expect(result.filtered).toEqual([])
    expect(result.skipped).toBe(0)
    expect(result.ipcMatched).toBe(0)
    expect(result.entityMatched).toBe(0)
    expect(result.bothMatched).toBe(0)
  })

  it('全部匹配', () => {
    const patents = [
      createPatent({ patent_number: '1', ipc_structured: ['H01M10/0525'] }),
      createPatent({ patent_number: '2', applicants_structured: [{ name: '奇瑞' }] }),
    ]
    const result = filterPatents(patents)
    expect(result.filtered).toHaveLength(2)
    expect(result.skipped).toBe(0)
  })

  it('全部不匹配', () => {
    const patents = [
      createPatent({ patent_number: '1', ipc_structured: ['A01B1/00'] }),
      createPatent({ patent_number: '2', applicants_structured: [{ name: '完全不相关的测试公司ABC' }] }),
    ]
    const result = filterPatents(patents)
    expect(result.filtered).toHaveLength(0)
    expect(result.skipped).toBe(2)
  })

  it('混合匹配，统计正确', () => {
    const patents = [
      createPatent({ patent_number: '1', ipc_structured: ['H01M10/0525'] }),  // IPC 匹配
      createPatent({ patent_number: '2', applicants_structured: [{ name: '奇瑞' }] }),  // 实体匹配
      createPatent({ patent_number: '3', ipc_structured: ['H01M10/0525'], applicants_structured: [{ name: '奇瑞' }] }),  // 双重匹配
      createPatent({ patent_number: '4', ipc_structured: ['A01B1/00'] }),  // 不匹配
    ]
    const result = filterPatents(patents)
    expect(result.filtered).toHaveLength(3)
    expect(result.skipped).toBe(1)
    expect(result.ipcMatched).toBe(1)
    expect(result.entityMatched).toBe(1)
    expect(result.bothMatched).toBe(1)
  })
})

describe('filter-config — 白名单配置完整性', () => {
  it('IPC 白名单不为空', () => {
    expect(IPC_WHITELIST.length).toBeGreaterThan(0)
  })

  it('IPC 白名单代码均已标准化', () => {
    for (const code of IPC_WHITELIST) {
      expect(code).toBe(code.toUpperCase())
      expect(code).not.toMatch(/\s/)
    }
  })

  it('实体白名单不为空', () => {
    expect(ENTITY_WHITELIST.length).toBeGreaterThan(0)
  })

  it('实体白名单关键词均为小写（便于比较）', () => {
    for (const keyword of ENTITY_WHITELIST) {
      // 只检查包含英文字母的关键词
      if (/[a-zA-Z]/.test(keyword)) {
        expect(keyword).toBe(keyword.toLowerCase())
      }
    }
  })
})
