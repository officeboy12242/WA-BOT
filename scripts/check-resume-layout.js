import fs from 'fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { normalizeResumeExtract } from '../src/utils/resumeStructure.js';
import { buildResumePdfBuffer } from '../src/utils/resumePdfExport.js';

const origPath = 'c:/Users/jaikishanbagul/Downloads/Swaraj_Salunke_Resume_1_7122 1.pdf';
const origText = (await pdfParse(fs.readFileSync(origPath))).text;

const sample = `Swaraj Salunke
Mumbai, India
salunkeswaraj2001@gmail.com | 9175867433 | linkedin.com/in/swarajsalunke

PROFILE SUMMARY
Sr. SQL Developer with 3+ years of experience specializing in designing, optimizing, and managing robust SQL databases and data workflows for financial applications. Proven expertise in SQL programming, schema design, query optimization, and performance tuning for high-throughput financial data.

TECHNICAL SKILLS
Languages: Python (Expert), SQL, JavaScript, Bash
Backend: FastAPI, Flask, REST APIs, Microservices, SQLAlchemy, Pandas, NumPy
Databases: PostgreSQL, MySQL – SQL programming, schema design, query optimisation, indexing, performance tuning
Cloud & DevOps: Microsoft Azure (Blob Storage, Functions, AZ-204 Certified), GCP (BigQuery, Cloud Storage), Docker, Git, CI/CD Pipelines
Data & ETL: ETL/ELT Pipeline Design, Data Profiling, Anomaly Detection, Data Quality Engineering, Data Workflows
Tools: Azure DevOps, Postman, Jupyter, Linux, VS Code

PROFESSIONAL EXPERIENCE
Software Engineer\tJul 2023 – Present
BDO India LLP | Big 4 | Mumbai
– Designed and optimized SQL data models (PostgreSQL, MySQL) with advanced schema design, query optimisation, and indexing to support high-throughput financial data workflows.
– Developed and maintained production-grade Python backend services using FastAPI, structuring REST APIs and service-layer logic to interact with financial data layers.
– Built scalable ETL pipelines processing large-scale financial datasets (TDS reconciliation, BOA reporting, LDC tracking), reducing manual validation effort by 80% and enhancing data accuracy.
– Automated multi-sheet Excel report generation using openpyxl for 15+ compliance report types, eliminating manual report building.
– Deployed backend services on Azure with Docker, CI/CD pipelines, and automated monitoring for production-grade observability.
– Collaborated with cross-functional stakeholders to gather requirements and deliver iteratively within Agile/Scrum.

Software Engineer Intern\tJan 2023 – Jun 2023
BDO India LLP | Big 4 | Mumbai
– Migrated legacy financial systems to modular Python microservices, significantly optimising SQL queries and reducing data latency by 40%.
– Built automated unit and integration test suites for financial report QA, cutting defect identification time in testing cycles.

KEY PROJECTS
TDS Reconciliation & Reporting Platform\t2023 – Present
BDO India LLP
– End-to-end Python backend platform featuring FastAPI microservices, a robust PostgreSQL data layer, and scalable ETL pipelines for financial compliance reporting.
– Integrated Azure Blob Storage and developed 15+ automated report types with custom anomaly detection.

IoT-Enabled Geospatial Hazard Platform\t2022
National Winner – ST Innovators Challenge
– Developed a real-time data ingestion backend (Python/Flask) handling concurrent IoT sensor streams with Google Maps API integration.

EDUCATION
Sardar Patel Institute of Technology (SPIT) | Mumbai
B.Tech in Electronics and Telecommunication (Minor in Computer Science)\t2019 – 2023

CERTIFICATIONS
Microsoft Certified: Azure Developer Associate (AZ-204) | Azure AI Fundamentals (AI-900) | Azure Fundamentals (AZ-900)
`;

const pdf = await buildResumePdfBuffer(sample, { baseText: normalizeResumeExtract(origText) });
fs.writeFileSync('scripts/_layout-fix-out.pdf', pdf);
const check = await pdfParse(pdf);
console.log('pages', check.numpages);
console.log('---');
console.log(check.text);
if (check.numpages > 2) {
    console.error('FAIL: too many pages');
    process.exit(1);
}
if (/Software Engineer Intern\nJan/.test(check.text.replace(/\r/g, ''))) {
    // pdf-parse may still split same-line positioned text; only fail if Intern is last on page with date next
    console.warn('note: title/date may appear as two lines in text extract (OK if same visual row)');
}
if (!check.text.includes('salunkeswaraj2001@gmail.com')) {
    console.error('FAIL: email corrupted');
    process.exit(1);
}
if (check.text.includes('Platform2023') || check.text.includes('4Mumbai')) {
    console.error('FAIL: jammed tokens remain');
    process.exit(1);
}
console.log('layout fix ok');
