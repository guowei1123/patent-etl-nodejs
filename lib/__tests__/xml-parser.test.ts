import { describe, expect, it } from 'vitest'
import { detectPatentType, parsePatentXml } from '../xml-parser'

// 发明专利 XML（含审查员、引用文献、结构化地址等完整字段）
const inventionXml = `
<PatentDocumentAndRelated
  kind="B"
  docNumber="104751825"
  country="CN"
  datePublication="20231003"
  status="C"
  lang="zh"
  file="CN102015000163325CN00001047518250BFULZH20231003CN00Q.XML">
  <BibliographicData>
    <PublicationReference dataFormat="original" sequence="1">
      <DocumentID>
        <WIPOST3Code>CN</WIPOST3Code>
        <DocNumber>104751825</DocNumber>
        <Kind>B</Kind>
        <Date>20231003</Date>
      </DocumentID>
    </PublicationReference>
    <ApplicationReference applType="10" dataFormat="original" sequence="1">
      <DocumentID>
        <WIPOST3Code>CN</WIPOST3Code>
        <DocNumber>201510163325.6</DocNumber>
        <Date>20150408</Date>
      </DocumentID>
    </ApplicationReference>
    <ClassificationIPCRDetails>
      <ClassificationIPCR sequence="1">
        <IPCVersionDate>20060101</IPCVersionDate>
        <Section>G</Section>
        <MainClass>09</MainClass>
        <Subclass>G</Subclass>
        <MainGroup>5</MainGroup>
        <Subgroup>10</Subgroup>
        <Text>G09G  5/10  (2006.01)</Text>
      </ClassificationIPCR>
      <ClassificationIPCR sequence="2">
        <IPCVersionDate>20060101</IPCVersionDate>
        <Section>G</Section>
        <MainClass>07</MainClass>
        <Subclass>F</Subclass>
        <MainGroup>19</MainGroup>
        <Subgroup>00</Subgroup>
        <Text>G07F 19/00  (2006.01)</Text>
      </ClassificationIPCR>
    </ClassificationIPCRDetails>
    <InventionTitle>金融自助终端的显示屏幕亮度调节系统及调节方法</InventionTitle>
    <ReferencesCited sourceDB="national office">
      <Citation srepPhase="SEA" sequence="1">
        <ApplicationCitation id="pcit000001" num="0001">
          <PublicationReference dataFormat="standard" sequence="1">
            <DocumentID>
              <WIPOST3Code>CN</WIPOST3Code>
              <DocNumber>203232659</DocNumber>
              <Kind>U</Kind>
              <Date>20131009</Date>
            </DocumentID>
          </PublicationReference>
        </ApplicationCitation>
      </Citation>
      <Citation srepPhase="SEA" sequence="2">
        <ApplicationCitation id="pcit000002" num="0002">
          <PublicationReference dataFormat="standard" sequence="1">
            <DocumentID>
              <WIPOST3Code>TW</WIPOST3Code>
              <DocNumber>M391159</DocNumber>
              <Kind>A1</Kind>
              <Date>20101021</Date>
            </DocumentID>
          </PublicationReference>
        </ApplicationCitation>
      </Citation>
    </ReferencesCited>
    <Parties>
      <ApplicantDetails>
        <Applicant sequence="1">
          <AddressBook lang="zh">
            <Name>恒银金融科技股份有限公司</Name>
            <Address>
              <Text>300308 天津市滨海新区自贸试验区西八道30号</Text>
              <Province>天津市</Province>
              <City>市辖区</City>
              <County>滨海新区</County>
              <PostCode>300308</PostCode>
              <WIPOST3Code>CN</WIPOST3Code>
            </Address>
          </AddressBook>
        </Applicant>
        <Applicant sequence="2">
          <AddressBook lang="zh">
            <Name>第二申请人公司</Name>
            <Address>
              <Text>100000 北京市海淀区某路1号</Text>
              <Province>北京市</Province>
              <City>北京市</City>
              <PostCode>100000</PostCode>
            </Address>
          </AddressBook>
        </Applicant>
      </ApplicantDetails>
      <InventorDetails>
        <Inventor sequence="1">
          <AddressBook><Name>江浩然</Name></AddressBook>
        </Inventor>
        <Inventor sequence="2">
          <AddressBook><Name>张三</Name></AddressBook>
        </Inventor>
      </InventorDetails>
      <AgentDetails>
        <CustomerNumber>12107</CustomerNumber>
        <Agent sequence="1">
          <Agency>
            <AddressBook>
              <OrganizationName>天津市三利专利商标代理有限公司 12107</OrganizationName>
            </AddressBook>
          </Agency>
          <AddressBook><Name>周庆路</Name></AddressBook>
        </Agent>
      </AgentDetails>
    </Parties>
    <AssigneeDetails>
      <Assignee sequence="1">
        <AddressBook lang="zh">
          <Name>恒银金融科技股份有限公司</Name>
          <Address>
            <Province>天津市</Province>
            <City>市辖区</City>
            <WIPOST3Code>CN</WIPOST3Code>
          </Address>
        </AddressBook>
      </Assignee>
    </AssigneeDetails>
    <ExaminerDetails>
      <Examiner sequence="1">
        <Name>李尊懋</Name>
      </Examiner>
      <Examiner sequence="2">
        <Name>王审查</Name>
      </Examiner>
    </ExaminerDetails>
  </BibliographicData>
  <Abstract>
    <Paragraphs num="0001">本发明涉及一种金融自助终端的显示屏幕亮度调节系统。</Paragraphs>
    <AbstractFigure>
      <Figure num="0001">
        <Image he="341" wi="1000" file="201510163325.JPG" imgContent="undefined" imgFormat="JPEG"/>
      </Figure>
    </AbstractFigure>
  </Abstract>
  <Description>
    <TechnicalField>
      <Paragraphs id="p0001">技术领域</Paragraphs>
      <Paragraphs id="p0002">本发明涉及金融设备领域。</Paragraphs>
    </TechnicalField>
    <BackgroundArt>
      <Paragraphs id="p0003">背景技术</Paragraphs>
      <Paragraphs id="p0004">现有技术存在不足，例如公开号CN102030405A所披露的方案。</Paragraphs>
    </BackgroundArt>
    <Disclosure>
      <Paragraphs id="p0005">发明内容</Paragraphs>
      <Paragraphs id="p0006">本发明所要解决的技术问题是提供一种亮度调节系统。</Paragraphs>
      <Paragraphs id="p0007">为解决上述技术问题，本发明采用如下技术方案。</Paragraphs>
      <Paragraphs id="p0008">本发明的有益效果是结构简单。</Paragraphs>
    </Disclosure>
  </Description>
  <Claims>
    <Claim id="cl0001" num="0001">
      <ClaimText>1.一种金融自助终端的亮度调节方法，其特征在于...</ClaimText>
    </Claim>
    <Claim id="cl0002" num="0002">
      <ClaimText>2.根据权利要求1所述的方法，其特征在于...</ClaimText>
    </Claim>
  </Claims>
</PatentDocumentAndRelated>
`

// 实用新型 XML（无审查员和引用文献）
const utilityModelXml = `
<PatentDocumentAndRelated
  kind="U"
  docNumber="219801493"
  country="CN"
  datePublication="20231003"
  status="C"
  file="CN202021000797205CN00002198014930UFULZH20231003CN00L.XML">
  <BibliographicData>
    <PublicationReference dataFormat="original" sequence="1">
      <DocumentID>
        <WIPOST3Code>CN</WIPOST3Code>
        <DocNumber>219801493</DocNumber>
        <Kind>U</Kind>
        <Date>20231003</Date>
      </DocumentID>
    </PublicationReference>
    <ApplicationReference applType="20" dataFormat="original" sequence="1">
      <DocumentID>
        <WIPOST3Code>CN</WIPOST3Code>
        <DocNumber>202120797205.2</DocNumber>
        <Date>20210419</Date>
      </DocumentID>
    </ApplicationReference>
    <ClassificationIPCRDetails>
      <ClassificationIPCR sequence="1">
        <Text>H01T  23/00  (2006.01)</Text>
      </ClassificationIPCR>
    </ClassificationIPCRDetails>
    <InventionTitle>气激式环境小气候负氧离子设备</InventionTitle>
    <Parties>
      <ApplicantDetails>
        <Applicant sequence="1">
          <AddressBook lang="zh">
            <Name>深圳市宏康环境科技有限公司</Name>
            <Address>
              <Text>518000 广东省深圳市南山区西丽街道</Text>
              <Province>广东省</Province>
              <City>深圳市</City>
              <PostCode>518000</PostCode>
            </Address>
          </AddressBook>
        </Applicant>
      </ApplicantDetails>
      <InventorDetails>
        <Inventor sequence="1">
          <AddressBook><Name>何相华</Name></AddressBook>
        </Inventor>
      </InventorDetails>
      <AgentDetails>
        <Agent sequence="1">
          <Agency>
            <AddressBook>
              <OrganizationName>长沙星耀专利事务所(普通合伙) 43205</OrganizationName>
            </AddressBook>
          </Agency>
          <AddressBook><Name>宁冈</Name></AddressBook>
        </Agent>
      </AgentDetails>
    </Parties>
    <AssigneeDetails>
      <Assignee sequence="1">
        <AddressBook lang="zh">
          <Name>深圳市宏康环境科技有限公司</Name>
          <Address>
            <Province>广东省</Province>
          </Address>
        </AddressBook>
      </Assignee>
    </AssigneeDetails>
  </BibliographicData>
  <Abstract>
    <Paragraphs>本实用新型涉及气激式环境小气候负氧离子设备。</Paragraphs>
    <AbstractFigure>
      <Figure num="0001">
        <Image file="202120797205.JPG"/>
      </Figure>
    </AbstractFigure>
  </Abstract>
  <Claims>
    <Claim id="cl0001" num="0001">
      <ClaimText>1.一种气激式负氧离子设备，其特征在于...</ClaimText>
    </Claim>
  </Claims>
</PatentDocumentAndRelated>
`

describe('xml-parser — 完整字段解析', () => {
  describe('发明专利', () => {
    it('提取根元素属性', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p).not.toBeNull()
      expect(p.kind).toBe('B')
      expect(p.pub_country).toBe('CN')
      expect(p.doc_status).toBe('C')
      expect(p.source_file).toBe(
        'CN102015000163325CN00001047518250BFULZH20231003CN00Q.XML',
      )
    })

    it('提取申请类型码和国别', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.app_type).toBe('10')
      expect(p.app_country).toBe('CN')
    })

    it('提取结构化申请人（含地址）', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.applicants_structured).toHaveLength(2)
      expect(p.applicants_structured![0]).toEqual({
        name: '恒银金融科技股份有限公司',
        address: '300308 天津市滨海新区自贸试验区西八道30号',
        province: '天津市',
        city: '市辖区',
        county: '滨海新区',
        postcode: '300308',
        country: 'CN',
      })
      expect(p.applicants_structured![1]!.name).toBe('第二申请人公司')
      // 扁平字段兼容
      expect(p.applicant).toBe('恒银金融科技股份有限公司; 第二申请人公司')
    })

    it('提取结构化代理人/机构（保留配对）', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.agents_structured).toHaveLength(1)
      expect(p.agents_structured![0]).toEqual({
        agent_name: '周庆路',
        agency_name: '天津市三利专利商标代理有限公司 12107',
      })
      // 扁平字段兼容
      expect(p.agent).toBe('周庆路')
      expect(p.agency).toBe('天津市三利专利商标代理有限公司 12107')
    })

    it('提取审查员', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.examiners).toEqual(['李尊懋', '王审查'])
    })

    it('提取引用文献', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.citations).toHaveLength(2)
      expect(p.citations![0]).toEqual({
        country: 'CN',
        doc_number: '203232659',
        kind: 'U',
        pub_date: '2013-10-09',
      })
      expect(p.citations![1]!.country).toBe('TW')
      expect(p.citations![1]!.doc_number).toBe('M391159')
      expect(p.citations![1]!.kind).toBe('A1')
    })

    it('提取受让人', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.assignees).toHaveLength(1)
      expect(p.assignees![0]!.name).toBe('恒银金融科技股份有限公司')
      expect(p.assignees![0]!.province).toBe('天津市')
      expect(p.assignees![0]!.country).toBe('CN')
    })

    it('提取说明书（结构化）', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.description).toBeTruthy()
      expect(p.description_structured).toBeDefined()
      expect(p.description_structured!.technical_field).toContain(
        '金融设备领域',
      )
      expect(p.description_structured!.background_art).toContain(
        '现有技术存在不足',
      )
      expect(p.description_structured!.disclosure).toContain(
        '本发明所要解决的技术问题',
      )
    })

    it('提取摘要附图', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.abstract_figure).toBe('201510163325.JPG')
      expect(p.image_files).toBeUndefined()
    })

    it('提取 TIFF 附图', () => {
      const xml = inventionXml
        .replace(
          '<Image he="341" wi="1000" file="201510163325.JPG" imgContent="undefined" imgFormat="JPEG"/>',
          '<Image he="341" wi="1000" file="202080024123.TIF" imgContent="undefined" imgFormat="TIFF"/>',
        )
        .replace(
          '<Description>',
          '<Description><InventionMode><Paragraphs><Image id="if0003" file="diagram.webp" imgContent="formula" imgFormat="WEBP"/></Paragraphs></InventionMode>',
        )
        .replace(
          '</Description>',
          '</Description><Drawings><Figure num="0001" figureLabels="图1"><Image id="if0001" file="312390.TIF" imgContent="drawing" imgFormat="TIFF"/></Figure><Figure num="0002" figureLabels="图2"><Image id="if0002" file="figure.PNG" imgContent="drawing" imgFormat="PNG"/></Figure></Drawings>',
        )
      const p = parsePatentXml(xml, 'invention')!
      expect(p.abstract_figure).toBe('202080024123.TIF')
      expect(p.image_files).toEqual([
        '312390.TIF',
        'figure.PNG',
        'diagram.webp',
      ])
      expect(p.image_references).toEqual([
        {
          file_name: '312390.TIF',
          image_role: 'drawing',
          figure_label: '图1',
        },
        {
          file_name: 'figure.PNG',
          image_role: 'drawing',
          figure_label: '图2',
        },
        {
          file_name: 'diagram.webp',
          image_role: 'inline',
          source_section: 'InventionMode',
        },
      ])
      expect(p.description_structured!.embodiment).toContain(
        '[[PATENT_IMAGE:diagram.webp]]',
      )
    })
    it('提取结构化权利要求', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.claims_structured).toHaveLength(2)
      expect(p.claims_structured![0]!.texts[0]).toContain('金融自助终端')
      expect(p.claims_structured![1]!.texts[0]).toContain('根据权利要求1')
    })

    it('提取语言', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.lang).toBe('zh')
    })

    it('提取申请人和专利权人国家', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.applicants_structured![0]!.country).toBe('CN')
      // 第二申请人未提供 WIPOST3Code
      expect(p.applicants_structured![1]!.country).toBeUndefined()
      expect(p.assignees![0]!.country).toBe('CN')
    })

    it('拆分发明内容为技术问题/技术方案/有益效果', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      const ds = p.description_structured!
      expect(ds.technical_problem).toContain('本发明所要解决的技术问题')
      expect(ds.technical_solution).toContain('采用如下技术方案')
      expect(ds.beneficial_effect).toContain('有益效果')
    })

    it('提取说明书提及文献', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.description_structured!.referenced_documents).toEqual([
        'CN102030405',
      ])
    })

    it('统计权利要求总数和独立权利要求数', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.claim_count).toBe(2)
      expect(p.independent_claim_count).toBe(1)
    })

    it('识别独立权利要求与从属权利要求', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.claims_structured![0]!.is_independent).toBe(true)
      expect(p.claims_structured![1]!.is_independent).toBe(false)
    })

    it('提取IPC分类（结构化和扁平均可用）', () => {
      const p = parsePatentXml(inventionXml, 'invention')!
      expect(p.ipc_codes).toEqual([
        'G09G  5/10  (2006.01)',
        'G07F 19/00  (2006.01)',
      ])
      expect(p.ipc_structured).toEqual(p.ipc_codes)
    })
  })

  describe('实用新型', () => {
    it('提取根元素属性', () => {
      const p = parsePatentXml(utilityModelXml, 'utility_model')!
      expect(p).not.toBeNull()
      expect(p.kind).toBe('U')
      expect(p.app_type).toBe('20')
    })

    it('无审查员和引用文献', () => {
      const p = parsePatentXml(utilityModelXml, 'utility_model')!
      expect(p.examiners).toBeUndefined()
      expect(p.citations).toBeUndefined()
    })

    it('提取结构化申请人（含地址）', () => {
      const p = parsePatentXml(utilityModelXml, 'utility_model')!
      expect(p.applicants_structured).toHaveLength(1)
      expect(p.applicants_structured![0]).toEqual({
        name: '深圳市宏康环境科技有限公司',
        address: '518000 广东省深圳市南山区西丽街道',
        province: '广东省',
        city: '深圳市',
        postcode: '518000',
      })
    })

    it('提取受让人', () => {
      const p = parsePatentXml(utilityModelXml, 'utility_model')!
      expect(p.assignees).toHaveLength(1)
      expect(p.assignees![0]!.name).toBe('深圳市宏康环境科技有限公司')
    })

    it('提取摘要附图', () => {
      const p = parsePatentXml(utilityModelXml, 'utility_model')!
      expect(p.abstract_figure).toBe('202120797205.JPG')
    })

    it('无说明书时 description 为 undefined', () => {
      const p = parsePatentXml(utilityModelXml, 'utility_model')!
      expect(p.description).toBeUndefined()
      expect(p.description_structured).toBeUndefined()
    })
  })

  describe('兼容旧接口', () => {
    it('preserves multi-value flat fields', () => {
      const xml = `
        <PatentDocumentAndRelated kind="B" docNumber="CN1234567B" datePublication="20240102">
          <BibliographicData>
            <InventionTitle>Sample Patent</InventionTitle>
            <PublicationReference>
              <DocumentID>
                <DocNumber>CN1234567B</DocNumber>
                <Date>20240102</Date>
              </DocumentID>
            </PublicationReference>
            <ApplicationReference>
              <DocumentID>
                <DocNumber>CN2023000001</DocNumber>
                <Date>20231201</Date>
              </DocumentID>
            </ApplicationReference>
            <Parties>
              <ApplicantDetails>
                <Applicant><AddressBook><Name>Alpha Corp</Name></AddressBook></Applicant>
                <Applicant><AddressBook><Name>Beta Labs</Name></AddressBook></Applicant>
              </ApplicantDetails>
              <InventorDetails>
                <Inventor><AddressBook><Name>Alice</Name></AddressBook></Inventor>
                <Inventor><AddressBook><Name>Bob</Name></AddressBook></Inventor>
              </InventorDetails>
              <AgentDetails>
                <Agent>
                  <AddressBook><Name>Agent One</Name></AddressBook>
                  <Agency><AddressBook><OrganizationName>Agency A</OrganizationName></AddressBook></Agency>
                </Agent>
                <Agent>
                  <AddressBook><Name>Agent Two</Name></AddressBook>
                  <Agency><AddressBook><OrganizationName>Agency B</OrganizationName></AddressBook></Agency>
                </Agent>
              </AgentDetails>
            </Parties>
            <ClassificationIPCRDetails>
              <ClassificationIPCR><Text>A01B 1/00</Text></ClassificationIPCR>
              <ClassificationIPCR><Text>B02C 2/00</Text></ClassificationIPCR>
            </ClassificationIPCRDetails>
          </BibliographicData>
          <Abstract><Paragraphs>Useful abstract</Paragraphs></Abstract>
          <Claims>
            <Claim><ClaimText>Claim one</ClaimText></Claim>
            <Claim><ClaimText>Claim two</ClaimText></Claim>
          </Claims>
        </PatentDocumentAndRelated>
      `

      const parsed = parsePatentXml(xml, 'invention')!

      expect(parsed).not.toBeNull()
      expect(parsed.patent_number).toBe('CN1234567B')
      expect(parsed.claims).toBe('Claim one\nClaim two')
      expect(parsed.applicant).toBe('Alpha Corp; Beta Labs')
      expect(parsed.inventor).toBe('Alice; Bob')
      expect(parsed.agent).toBe('Agent One; Agent Two')
      expect(parsed.agency).toBe('Agency A; Agency B')
      expect(parsed.ipc_codes).toEqual(['A01B 1/00', 'B02C 2/00'])
      expect(parsed.application_number).toBe('CN2023000001')
      expect(parsed.application_date).toBe('2023-12-01')
      expect(parsed.publication_date).toBeUndefined()

      // 新字段也应可用
      expect(parsed.kind).toBe('B')
      expect(parsed.agents_structured).toHaveLength(2)
      expect(parsed.agents_structured![0]).toEqual({
        agent_name: 'Agent One',
        agency_name: 'Agency A',
      })
      expect(parsed.claims_structured).toHaveLength(2)
    })

    it('prefers RelatedDocuments date for publication date', () => {
      const xml = `
        <business:PatentDocumentAndRelated
          xmlns:business="http://example.com/business"
          xmlns:base="http://example.com/base"
          kind="B"
          docNumber="CN1234567B">
          <business:BibliographicData>
            <business:InventionTitle>Related Publication Patent</business:InventionTitle>
            <business:PublicationReference>
              <base:DocumentID>
                <base:DocNumber>CN1234567B</base:DocNumber>
                <base:Date>20231003</base:Date>
              </base:DocumentID>
            </business:PublicationReference>
            <business:RelatedDocuments>
              <business:RelatedPublicationDoc>
                <base:DocumentID>
                  <base:DocNumber>CN106307615A</base:DocNumber>
                  <base:Date>20170111</base:Date>
                </base:DocumentID>
              </business:RelatedPublicationDoc>
            </business:RelatedDocuments>
          </business:BibliographicData>
        </business:PatentDocumentAndRelated>
      `

      const parsed = parsePatentXml(xml, 'invention')!

      expect(parsed.publication_date).toBe('2017-01-11')
    })

    it('keeps grant fields empty for invention application publications', () => {
      const xml = `
        <PatentDocumentAndRelated kind="A" docNumber="CN1234567A">
          <BibliographicData>
            <InventionTitle>Application Publication Patent</InventionTitle>
            <PublicationReference>
              <DocumentID>
                <DocNumber>CN1234567A</DocNumber>
                <Date>20240102</Date>
              </DocumentID>
            </PublicationReference>
          </BibliographicData>
        </PatentDocumentAndRelated>
      `

      const parsed = parsePatentXml(xml, 'invention_application')!

      expect(parsed.publication_date).toBe('2024-01-02')
      expect(parsed.grant_number).toBeUndefined()
      expect(parsed.grant_date).toBeUndefined()
    })

    it('stores utility model publication reference as grant date only', () => {
      const xml = `
        <PatentDocumentAndRelated kind="U" docNumber="CN1234567U">
          <BibliographicData>
            <InventionTitle>Utility Model Patent</InventionTitle>
            <PublicationReference>
              <DocumentID>
                <DocNumber>CN1234567U</DocNumber>
                <Date>20240102</Date>
              </DocumentID>
            </PublicationReference>
          </BibliographicData>
        </PatentDocumentAndRelated>
      `

      const parsed = parsePatentXml(xml, 'utility_model')!

      expect(parsed.publication_date).toBeUndefined()
      expect(parsed.grant_number).toBe('CN1234567U')
      expect(parsed.grant_date).toBe('2024-01-02')
    })

    it('extracts priority details from namespaced priority nodes', () => {
      const xml = `
        <business:PatentDocumentAndRelated
          xmlns:business="http://example.com/business"
          xmlns:base="http://example.com/base"
          kind="A"
          docNumber="CN1234567A">
          <business:BibliographicData>
            <business:InventionTitle>Priority Patent</business:InventionTitle>
            <business:PublicationReference>
              <base:DocumentID>
                <base:DocNumber>CN1234567A</base:DocNumber>
                <base:Date>20240102</base:Date>
              </base:DocumentID>
            </business:PublicationReference>
            <business:PriorityDetails>
              <business:Priority kind="international" dataFormat="original" sourceDB="national office" sequence="1">
                <base:WIPOST3Code>KR</base:WIPOST3Code>
                <base:DocNumber>10-2022-0100096</base:DocNumber>
                <base:Date>20220810</base:Date>
              </business:Priority>
              <business:Priority kind="international" dataFormat="standard" sequence="1">
                <base:WIPOST3Code>KR</base:WIPOST3Code>
                <base:DocNumber>102022000100096</base:DocNumber>
                <base:Date>20220810</base:Date>
              </business:Priority>
            </business:PriorityDetails>
          </business:BibliographicData>
        </business:PatentDocumentAndRelated>
      `

      const parsed = parsePatentXml(xml, 'invention_application')!

      expect(parsed.priority_info).toEqual({
        priorities: [
          {
            country: 'KR',
            doc_number: '10-2022-0100096',
            date: '2022-08-10',
            kind: 'international',
            data_format: 'original',
            source_db: 'national office',
            sequence: '1',
          },
          {
            country: 'KR',
            doc_number: '102022000100096',
            date: '2022-08-10',
            kind: 'international',
            data_format: 'standard',
            source_db: undefined,
            sequence: '1',
          },
        ],
      })
    })

    it('parses lowercase and hyphenated compatibility nodes', () => {
      const xml = `
        <patent-document kind="B">
          <bibliographic-data>
            <invention-title>Fallback Patent</invention-title>
            <publication-reference>
              <document-id>
                <doc-number>CN9988776B</doc-number>
                <date>20240203</date>
              </document-id>
            </publication-reference>
            <application-reference>
              <document-id>
                <wipo-st3-code>CN</wipo-st3-code>
                <doc-number>CN2023999999</doc-number>
                <date>20230115</date>
              </document-id>
            </application-reference>
            <parties>
              <applicants>
                <applicant>Compat Applicant</applicant>
              </applicants>
              <inventors>
                <inventor>Compat Inventor</inventor>
              </inventors>
              <agents>
                <agent>Compat Agent</agent>
              </agents>
            </parties>
            <classification-ipc>
              <main-classification>H04L 12/58</main-classification>
            </classification-ipc>
            <abstract>Compat abstract</abstract>
          </bibliographic-data>
          <agency>Compat Agency</agency>
          <claims>Compat claim</claims>
        </patent-document>
      `

      const parsed = parsePatentXml(xml, 'invention')!

      expect(parsed).not.toBeNull()
      expect(parsed.patent_number).toBe('CN9988776B')
      expect(parsed.title).toBe('Fallback Patent')
      expect(parsed.abstract).toBe('Compat abstract')
      expect(parsed.claims).toBe('Compat claim')
      expect(parsed.applicant).toBe('Compat Applicant')
      expect(parsed.inventor).toBe('Compat Inventor')
      expect(parsed.agent).toBe('Compat Agent')
      expect(parsed.agency).toBe('Compat Agency')
      expect(parsed.application_number).toBe('CN2023999999')
      expect(parsed.application_date).toBe('2023-01-15')
      expect(parsed.publication_date).toBeUndefined()
      expect(parsed.ipc_codes).toEqual(['H04L 12/58'])
      expect(parsed.agents_structured).toEqual([
        {
          agent_name: 'Compat Agent',
          agency_name: 'Compat Agency',
        },
      ])
    })

    it('detects patent type from kind attribute on namespaced root elements', () => {
      const xml = `
        <ns:PatentDocumentAndRelated xmlns:ns="urn:test" kind="U" docNumber="CN7654321U">
          <ns:BibliographicData />
        </ns:PatentDocumentAndRelated>
      `
      expect(detectPatentType(xml)).toBe('utility_model')
    })
  })
})
