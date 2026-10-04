# Business Intelligence Architecture for the K-Beauty Salon System

## Recommended figure title

**Figure 3.X. Business Intelligence Architecture and Module Integration of the Web-Based Salon Management and Business Intelligence System for K-Beauty Salon**

## Figure structure

```text
CLIENT / STAFF / ADMIN OPERATIONS
  Client booking and QR/cash reservation | Service delivery | Staff scheduling
  Payment review | Inventory maintenance | Payroll preparation
                              |
                              v
SALON MANAGEMENT MODULES
  Appointments | Services | Clients | Staff | Transactions / Payments
  Inventory | Payroll | Notifications
                              |
                              v
FIRESTORE OPERATIONAL DATABASE
  appointments | services | users | transactions | inventory
  payrollSettings | payrollRecords | stylistSchedules | slotBlocks
                              |
                              v
DATA PROCESSING AND ANALYTICS LAYER
  Status filtering | Date-range filtering | Aggregation | Grouping
  Revenue and rate calculations | Frequency and trend analysis
  Low-stock checks | Completed-service commission calculation
                              |
                              v
BUSINESS INTELLIGENCE OUTPUTS
  Admin Dashboard | Sales & Analytics | Reports Center | Payroll Report
                              |
                              v
KPIs, REPORTS, AND EXPORTS
  Revenue | Bookings | Completion rate | Service/category performance
  Client activity | Payment methods | Inventory measures | Payroll totals
  PDF reports | CSV exports | Printed payslips
```

## Architecture description

The Business Intelligence (BI) architecture of the Web-Based Salon Management and Business Intelligence System for K-Beauty Salon integrates operational data produced by normal salon activities. Client, staff, and administrator actions create and update records for appointments, services, clients, staff, payments, inventory, schedules, and payroll. These records are stored in Cloud Firestore and are reused by the administrative dashboard, analytics displays, reports, and payroll tools. BI is therefore integrated into the salon management system rather than operated as a separate application.

The system applies descriptive analytics. Its JavaScript analytics layer filters records by appointment status and report period, groups data by month, service category, and payment method, counts bookings and clients, and calculates totals, averages, rates, commissions, and stock measures. No machine-learning, predictive, or forecasting claims are made by the current implementation.

For revenue calculations, the system uses only appointments whose status is **Served** or **Completed**. This prevents pending, cancelled, denied, and no-show appointments from being included as completed-service revenue. The same completed-service rule is used when payroll calculates a staff member's commission within a selected payroll period.

## Actual data inputs and processing

| Operational source | Actual data used | Processing and BI use |
| --- | --- | --- |
| `appointments` | date/bookingDate, status, price, serviceName, category, staffUid/staffName, client, reservation payment fields | Filters served/completed appointments for revenue; counts bookings; groups revenue by month/category/payment method; calculates completion rate; produces staff service revenue for commission. |
| `services` | service name, category, price, duration | Provides the service/category context used in booking, revenue/category analysis, and appointment reporting. |
| `users` | client/staff identity, role, specialties | Supplies client counts and staff identities; specialty data supports qualified stylist selection. |
| `transactions` | amount, payment method, reference number, payment date, payment status, appointment ID | Maintains reservation-payment records and supports transaction administration and payment traceability. |
| `inventory` | item, stock, threshold, cost | Calculates total item count, low-stock count, and inventory value; feeds inventory reports and alerts. |
| `payrollSettings` and `payrollRecords` | basic salary, rate, overtime, allowances, deductions, gross pay, net pay, payroll status | Stores authorized compensation settings and generated payroll records for payroll reports, CSV export, and printed payslips. |
| `stylistSchedules` and `slotBlocks` | working hours, blocks, appointment time ranges | Supports availability and conflict checking before an appointment is saved. |

## Analytical methods

- Descriptive analytics through totals, counts, summaries, and current-period comparisons.
- Aggregation of served/completed appointment prices into daily, monthly, and all-time revenue.
- Grouping by service category and payment method.
- Frequency analysis of booking volume by week or month.
- Percentage/rate calculation for completion rate.
- Comparative status filtering to exclude non-completed appointments from completed-service revenue and commission.
- Threshold analysis for low-stock inventory items.

## KPIs and their system locations

| KPI | Data basis | Output location |
| --- | --- | --- |
| Total revenue, current-month revenue, average ticket | Served/completed appointments and price | Sales & Analytics dashboard; Sales Report |
| Booking volume | Appointment dates and active booking statuses | Booking Volume chart; Appointment Report |
| Completion rate | Served/completed appointments divided by period bookings | Reports Center; Appointment Report |
| Service/category performance | Served/completed appointments grouped by category | Service Category Revenue chart; Sales Report |
| Client activity and average visits | Client records matched with served/completed appointments | Reports Center; Client Report |
| Payment method distribution | Appointment payment method/reservation payment method | Payment Methods chart; transaction records |
| Inventory total, low stock, inventory value | Inventory stock, threshold, and cost | Inventory module; Inventory Report |
| Staff completed-service revenue and commission | Served/completed appointments assigned to staff inside a payroll period | Payroll calculator, payslip, Payroll Report |
| Gross pay, deductions, and net pay | Payroll record compensation components | Payroll Report, CSV export, printed payslip |

## Dashboard and report integration

The Admin Dashboard presents operational KPIs and links to Sales & Analytics, Inventory, Payroll, and Reports Center. Sales & Analytics displays total revenue, monthly revenue, total clients, average ticket, monthly revenue and booking trends, service-category revenue, booking volume, payment method distribution, and recent financial rows. The Reports Center produces sales, client, appointment, and inventory reports and retains the system's PDF export features. Payroll provides a separate sensitive report with CSV export and a print-ready individual payslip.

## Module-integration examples

```text
Client booking -> appointment -> served/completed service -> revenue aggregation
-> dashboard KPI / sales report / payroll commission

QR or cash reservation -> transaction record and payment status -> transaction administration
-> payment-method analysis and payment traceability

Inventory update -> stock and threshold evaluation -> low-stock indicator / inventory report

Staff payroll settings + completed assigned services -> commission and compensation calculation
-> gross pay / deductions / net pay -> payroll report and payslip
```

## Suggested Chapter 3 narrative

The proposed system uses an integrated Business Intelligence architecture in which data generated by client, staff, and administrator operations is stored in Cloud Firestore and processed by the administrative application. The main operational inputs are appointment, service, client, staff, transaction, inventory, and payroll records. The system filters and aggregates these records to calculate management information such as completed-service revenue, booking volume, completion rate, service-category performance, client activity, payment-method distribution, low-stock items, inventory value, staff commission, and payroll totals.

The analytics layer uses descriptive analytical methods, including filtering, grouping, aggregation, frequency analysis, trend analysis, and percentage calculation. For financial accuracy, only appointments marked Served or Completed are included in completed-service revenue and staff commission computations. The resulting KPIs are displayed through the Admin Dashboard, Sales & Analytics page, Reports Center, Inventory module, and Payroll module. Existing PDF and CSV exports transform these outputs into management reports, while the payroll module also produces print-ready individual payslips. This integration enables the salon to use operational records directly for monitoring performance and supporting routine managerial decisions.

## Scope note

This architecture describes the current implemented system. It does not claim predictive analytics, artificial intelligence, machine learning, external payment-gateway processing, statutory tax calculations, or automated attendance-derived overtime.
