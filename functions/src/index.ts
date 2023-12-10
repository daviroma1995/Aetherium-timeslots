import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

interface Appointment {
  id?: string;
  client_id: string;
  date: null | string;
  date_timestamp: {
    __time__: string;
  };
  start_time: string;
  end_time: string;
  email: string;
  employee_id_list: string[];
  notes: string;
  total_duration: number;
  number: string;
  status_id: string;
  time: string;
  treatment_id_list: string[];
  room_id_list: string[];
}

interface TimeSlot {
  start_time: Date;
  end_time: Date;
  employee_id_list?: string[];
  room_id_list?: string[];
}

interface WorkingHours {
  start: Date;
  end: Date;
}

interface Treatment {
  id: string;
  duration: number;
  is_employee_required: boolean;
  room_id_list: string[];
  name: string;
}

interface Employee {
  id:string;
  name: string;
  picture: string;
  treatment_id_list: string[];
  start_time_shift: Date,
  end_time_shift: Date,
  working_hours: {
    day_of_week: string;
    start: string;
    end: string;
    is_working_day: boolean;
  }[];
}

interface ShopInfo {
  id: string;
  description: string;
  email: string;
  phone_number: string;
  opening_hours: {
    day: string;
    opening_time: string;
    closing_time: string;
    opened: boolean;
  }[];
}
interface data {
  date: string;
  treatments: Treatment[];
  appointment_id: string;
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
exports.timeslots = functions.https.onRequest(async (data, context) => {
  
  const myData:data = JSON.parse(data.body);
  console.log("incoming data", myData);

  const appointmentDate: string = myData.date;
  const appointmentId = myData?.appointment_id;
  const treatmentList: Treatment[] = myData.treatments;

  console.log(appointmentDate);
  console.log(treatmentList)

  try {
    const appointments = await getAppointmentsByDate(appointmentDate);
    const employees = await getAllEmployees();
    const workingHours = await getShopWorkingHours(appointmentDate);
   
    if (!workingHours ) {
      context.status(400).send({error: "working hour issue"});
      return;
    }
    console.log("workingHours before: ", (workingHours.start));
    updateWorkingHoursIfNeeded(workingHours, appointmentDate);

    const possibleEmployees = getPossibleEmployees(employees, appointmentDate);

    console.log("workingHours after: ", (workingHours.start));

   
    // find possible time slots
    const possibleTimeslots = await findPossibleTimeslots(treatmentList, possibleEmployees, appointments, workingHours!, appointmentId);

    console.log("possibleTimeslots", (possibleTimeslots));
    context.send(possibleTimeslots);
  } catch (error) {
    console.error("Error getting appointments:", error);
    context.status(400).send({
      "error":error
    });
    return;
  }
});

async function getAppointmentsByDate(date: string): Promise<Appointment[]> {
  const appointmentsSnapshot = await db
      .collection("appointments")
      .where("date", "==", date)
      .get();

  const appointments: Appointment[] = appointmentsSnapshot.docs.map((doc) => {
    const appointment = doc.data() as Appointment;
    appointment.id = doc.id;
    return appointment;
  });

  return appointments;
}


async function getShopWorkingHours(dateString: string): Promise<WorkingHours | null> {
  const date = new Date(dateString);
  const shopInfoDoc = await db.collection("shop_info").limit(1).get();
  const shopInfoData = shopInfoDoc.docs[0].data() as ShopInfo;

  const dayOfWeek = date.toLocaleDateString("en-US", { weekday: "long" });

  const workingHours = shopInfoData.opening_hours.find((hours) => hours.day === dayOfWeek);

  if (workingHours && workingHours.opened) {
    const startWorkingTime = convertToISO8601Date(dateString, workingHours.opening_time);
    const endWorkingTime = convertToISO8601Date(dateString, workingHours.closing_time);

    return {
      start: startWorkingTime,
      end: endWorkingTime,
    };
  }

  return null;
}

async function findPossibleTimeslots(
    treatmentList: Treatment[],
    possibleEmployees: Employee[],
    appointments: Appointment[],
    workingHours: WorkingHours,
    appointmentId: string
): Promise<TimeSlot[]> {

  const totalDuration = treatmentList.reduce(
      (duration, treatment) => duration + treatment.duration,
      0
  );
  const possibleTimeslots: TimeSlot[] = [];
  const workingHoursEnd  = new Date(workingHours.end);
  
  let currentStartTime = new Date(workingHours.start);
  let currentEndTime = new Date(currentStartTime);
  currentEndTime.setMinutes( currentStartTime.getMinutes() + totalDuration );
  
  while (currentEndTime.getTime() <= workingHoursEnd.getTime()) {

    const bookedAppTimeSlots = appointments.filter(
      (app) =>
      app.id !== appointmentId &&
      hasOverlap(new Date(app.start_time).getTime(), currentStartTime.getTime(),
       new Date(app.end_time).getTime(), currentEndTime.getTime())
  );

    const bookedRooms = getBookedRooms(bookedAppTimeSlots);
    const bookedEmployees = getBookedEmployees(bookedAppTimeSlots);

    const employeesInvolved = getEmployeesInvolved(treatmentList, currentStartTime, currentEndTime, possibleEmployees);
    const availableRooms = findAvailableRooms(treatmentList, bookedRooms);
    console.log("bookedRooms", bookedRooms);
    console.log("bookedEmployees", bookedEmployees);
    console.log("employeesInvolved", employeesInvolved);
    console.log("availableRooms", availableRooms);
    const no_employees_required = employeesInvolved?.length === 0;
    
    if (employeesInvolved && availableRooms) {
      if(no_employees_required || !employeesInvolved.some((emp) => bookedEmployees.includes(emp)))
      possibleTimeslots.push({
        start_time: currentStartTime,
        end_time: currentEndTime,
        employee_id_list: employeesInvolved,
        room_id_list: availableRooms,
      });
    }
    
    currentStartTime = new Date(currentStartTime);
    currentStartTime.setMinutes(currentStartTime.getMinutes() + 30);
    currentEndTime = new Date(currentStartTime);
    currentEndTime.setMinutes( currentStartTime.getMinutes() + totalDuration );
  }

  return possibleTimeslots;
}

async function getAllEmployees(): Promise<Employee[]> {
  const employeesSnapshot = await db.collection("employees").get();
  const employees: Employee[] = employeesSnapshot.docs.map((doc) => {
    const emp = doc.data() as Employee;
    emp.id = doc.id;
    return emp;
  });
  return employees;
}

function getEmployeesInvolved(treatmentList: Treatment[], appStartTime: Date, appEndTime: Date, possibleEmployees: Employee[]): string[] | null {
 
  const employeesInvolvedIdSet = new Set<string>();
   
  if(treatmentList.some(treatment => treatment.is_employee_required)) {
    for (const treatment of treatmentList) {
      if (treatment.is_employee_required) {

        const availableEmployees = possibleEmployees.filter((emp) => {

          return emp.treatment_id_list.includes(treatment.id) &&
          (emp.start_time_shift.getTime() <= appStartTime.getTime() && emp.end_time_shift.getTime() >= appEndTime.getTime());
        });

        if (availableEmployees.length === 0) {
          return null;
        }

        for(const emp of availableEmployees) {
          if(!employeesInvolvedIdSet.has(emp.id)) {
            employeesInvolvedIdSet.add(emp.id);
            break;
          }
        }      
      }
    }
  }

  return [...employeesInvolvedIdSet];
}

function findAvailableRooms(treatments: Treatment[], bookedRooms: string[]): string[] | null {
  const availableRooms = new Set<string>();

  for (const treatment of treatments) {

    if (treatment.room_id_list.every((room) => bookedRooms.includes(room))) {
      return null;
    }

    if(!hasCommonRooms(treatment.room_id_list, availableRooms)) {
      for (const room of treatment.room_id_list) {
          availableRooms.add(room);
      }
    }
  }

  return availableRooms?.size > 0 ? [...availableRooms] : null;
}

function hasCommonRooms(possibleRooms: string[], availableRooms: Set<string>): string | null {
  for (const room of possibleRooms) {
    if(availableRooms.has(room)) {
      return room;
    }
  }
  return null;
}


function convertToISO8601Date(dateString: string, timeString: string): Date {
  const [month, day, year] = dateString.split("/");
  const [hours, minutes] = timeString.split(":");

  // Create a new Date object with the components
  return new Date(`${year}-${month}-${day}T${hours}:${minutes}:00`);
}

function updateWorkingHoursIfNeeded(workingHours: WorkingHours, incomingDate: string): void {
  console.log("incomingDate", incomingDate);
  console.log("is same day", isSameDay(incomingDate));

  if (isSameDay(incomingDate)) {
    const currentDate = new Date();
    currentDate.setMinutes(0);
    currentDate.setHours(currentDate.getHours() + 3)
    workingHours.start = currentDate;
  }
}

function isSameDay(dateString: string) {
  const [month, day, year] = dateString.split('/').map(Number);
  const providedDate = new Date(year, month - 1, day);
  const currentDate = new Date();

  return (
    currentDate.getFullYear() === providedDate.getFullYear() &&
    currentDate.getMonth() === providedDate.getMonth() &&
    currentDate.getDate() === providedDate.getDate()
  );
}

function hasOverlap(slot1Start: number, slot2Start: number, slot1End: number, slot2End: number): boolean {
  return (
    slot1Start < slot2End && // Check if slot1 starts before slot2 ends
    slot1End  > slot2Start    // Check if slot1 ends after slot2 starts
  );
}

function getEmployeeWorkingHours(employee: Employee, dayOfWeek: string) {
  return employee.working_hours.find((hours) => hours.day_of_week === dayOfWeek);
}

function getBookedRooms(appointmentList: Appointment[]): string[] {
  return [...new Set(appointmentList.flatMap((app) => app.room_id_list))];
}
function getBookedEmployees(appointmentList: Appointment[]): string[] {
  return [...new Set(appointmentList.flatMap((app) => app.employee_id_list))];
}

function getPossibleEmployees(
  employees: Employee[],
  appointmentDate: string
): Employee[] {
const availableEmployees: Employee[] = [];

const dayOfWeek = new Date(appointmentDate).toLocaleDateString("en-US", { weekday: "long" });
console.log("dayOfWeek", dayOfWeek);

employees.forEach((emp) => {
  const workingHours = getEmployeeWorkingHours(emp, dayOfWeek)

  if (
    workingHours !== undefined &&
    workingHours.is_working_day
  ) {
    emp.start_time_shift = convertToISO8601Date(appointmentDate, workingHours.start);
    emp.end_time_shift =  convertToISO8601Date(appointmentDate, workingHours.end);
    availableEmployees.push(emp);
  }
});

return availableEmployees;
}




