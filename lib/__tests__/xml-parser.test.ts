import { describe, expect, it } from 'vitest'
import { detectPatentType, parsePatentXml } from '../xml-parser'

describe('xml-parser', () => {
  it('preserves multi-value fields in newer XML structures', () => {
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
              <Applicant>
                <AddressBook>
                  <Name>Alpha Corp</Name>
                </AddressBook>
              </Applicant>
              <Applicant>
                <AddressBook>
                  <Name>Beta Labs</Name>
                </AddressBook>
              </Applicant>
            </ApplicantDetails>
            <InventorDetails>
              <Inventor>
                <AddressBook>
                  <Name>Alice</Name>
                </AddressBook>
              </Inventor>
              <Inventor>
                <AddressBook>
                  <Name>Bob</Name>
                </AddressBook>
              </Inventor>
            </InventorDetails>
            <AgentDetails>
              <Agent>
                <AddressBook>
                  <Name>Agent One</Name>
                </AddressBook>
                <Agency>
                  <AddressBook>
                    <OrganizationName>Agency A</OrganizationName>
                  </AddressBook>
                </Agency>
              </Agent>
              <Agent>
                <AddressBook>
                  <Name>Agent Two</Name>
                </AddressBook>
                <Agency>
                  <AddressBook>
                    <OrganizationName>Agency B</OrganizationName>
                  </AddressBook>
                </Agency>
              </Agent>
            </AgentDetails>
          </Parties>
          <ClassificationIPCRDetails>
            <ClassificationIPCR>
              <Text>A01B 1/00</Text>
            </ClassificationIPCR>
            <ClassificationIPCR>
              <Text>B02C 2/00</Text>
            </ClassificationIPCR>
          </ClassificationIPCRDetails>
        </BibliographicData>
        <Abstract>
          <Paragraphs>Useful abstract</Paragraphs>
        </Abstract>
        <Claims>
          <Claim>
            <ClaimText>Claim one</ClaimText>
          </Claim>
          <Claim>
            <ClaimText>Claim two</ClaimText>
          </Claim>
        </Claims>
      </PatentDocumentAndRelated>
    `

    const parsed = parsePatentXml(xml, 'invention')

    expect(parsed).not.toBeNull()
    expect(parsed?.patent_number).toBe('CN1234567B')
    expect(parsed?.claims).toBe('Claim one\nClaim two')
    expect(parsed?.applicant).toBe('Alpha Corp; Beta Labs')
    expect(parsed?.inventor).toBe('Alice; Bob')
    expect(parsed?.agent).toBe('Agent One; Agent Two')
    expect(parsed?.agency).toBe('Agency A; Agency B')
    expect(parsed?.ipc_codes).toEqual(['A01B 1/00', 'B02C 2/00'])
    expect(parsed?.application_number).toBe('CN2023000001')
    expect(parsed?.application_date).toBe('2023-12-01')
    expect(parsed?.publication_date).toBe('2024-01-02')
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
